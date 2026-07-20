import { createClient } from '@supabase/supabase-js';
import { Client } from '@upstash/qstash';
import { waitUntil } from '@vercel/functions';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const qstash = new Client({ token: process.env.QSTASH_TOKEN });

const MINUTOS_TIMEOUT_HUMANO = 5;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method === 'POST') {
    try {
      const { entry } = req.body;
      const entryItem = entry?.[0];

      const accountId = entryItem?.id;

      const messagingEvent = entryItem?.messaging?.[0];
      const change = entryItem?.changes?.[0];

      let senderId, userMessage, wamid;

      if (messagingEvent?.message?.text) {
        senderId = messagingEvent.sender?.id;
        userMessage = messagingEvent.message.text;
        wamid = messagingEvent.message.mid;
      } else if (change?.field === 'messages' && change.value?.message?.text) {
        senderId = change.value.sender?.id;
        userMessage = change.value.message.text;
        wamid = change.value.message.mid;
      } else {
        return res.status(200).send('EVENT_RECEIVED');
      }

      if (!senderId || !userMessage || !wamid) {
        return res.status(200).send('EVENT_RECEIVED');
      }

      waitUntil(encolarMensaje({ senderId, userMessage, wamid, accountId }));

      return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
      console.error('ERROR DETALLADO:', error.stack);
      if (!res.headersSent) {
        return res.status(500).send('Error');
      }
    }
  }
}

async function encolarMensaje({ senderId, userMessage, wamid, accountId }) {
  try {
    let { data: conversation } = await supabase
      .from('conversations')
      .select('*')
      .eq('sender_id', senderId)
      .eq('account_id', accountId)
      .single();

    if (!conversation) {
      const { data: newConv } = await supabase
        .from('conversations')
        .insert({ sender_id: senderId, account_id: accountId })
        .select()
        .single();
      conversation = newConv;
    }

    const { error: insertError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        wa_message_id: wamid,
        role: 'user',
        content: userMessage,
      });

    if (insertError) {
      console.log('Mensaje duplicado, ignorado:', wamid);
      return;
    }

    if (conversation.is_human) {
      const minutosDesdeUltimaActividad =
        (Date.now() - new Date(conversation.updated_at).getTime()) / 1000 / 60;

      if (minutosDesdeUltimaActividad < MINUTOS_TIMEOUT_HUMANO) {
        console.log('Conversación en modo humano (activo), no se encola:', senderId);
        return;
      }

      await supabase
        .from('conversations')
        .update({ is_human: false })
        .eq('id', conversation.id);

      console.log('Timeout de modo humano cumplido, bot reactivado para:', senderId);
    }

    // Fila y límite de velocidad INDEPENDIENTE por cada cuenta/marca
    await qstash.publishJSON({
      url: `${process.env.APP_URL}/api/process`,
      body: { senderId, userMessage, wamid, conversationId: conversation.id, accountId },
      flowControl: {
        key: `gemini-${accountId}`,
        rate: 15,
        period: '60s',
        parallelism: 1,
      },
    });
  } catch (error) {
    console.error('Error encolando mensaje:', error);
  }
}
