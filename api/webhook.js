import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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
        // Evento sin texto (read/delivery, etc.) - lo ignoramos
        return res.status(200).send('EVENT_RECEIVED');
      }

      if (!senderId || !userMessage || !wamid) {
        return res.status(200).send('EVENT_RECEIVED');
      }

      // Le decimos a Vercel: "sigue corriendo esto aunque ya respondamos"
      waitUntil(procesarMensaje({ senderId, userMessage, wamid }));

      // Respondemos a Meta YA, sin esperar a Gemini
      return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
      console.error('ERROR DETALLADO:', error.stack);
      if (!res.headersSent) {
        return res.status(500).send('Error');
      }
    }
  }
}

async function procesarMensaje({ senderId, userMessage, wamid }) {
  try {
    // 1. Buscar o crear la conversación de este usuario
    let { data: conversation } = await supabase
      .from('conversations')
      .select('*')
      .eq('sender_id', senderId)
      .single();

    if (!conversation) {
      const { data: newConv } = await supabase
        .from('conversations')
        .insert({ sender_id: senderId })
        .select()
        .single();
      conversation = newConv;
    }

    // 2. Intentar guardar el mensaje del usuario (deduplicación por wa_message_id)
    const { error: insertError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        wa_message_id: wamid,
        role: 'user',
        content: userMessage,
      });

    if (insertError) {
      // Si falla por duplicado (unique constraint), ya se procesó antes -> no hacemos nada más
      console.log('Mensaje duplicado, ignorado:', wamid);
      return;
    }

    // 3. Si un humano está atendiendo esta conversación, el bot no responde
    if (conversation.is_human) {
      console.log('Conversación en modo humano, bot no responde:', senderId);
      return;
    }

    // 4. Generar respuesta con Gemini
    const botResponse = await generarRespuestaGemini(userMessage);

    // 5. Guardar la respuesta del bot
    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      wa_message_id: `bot_${wamid}`,
      role: 'bot',
      content: botResponse,
    });

    // 6. Enviar la respuesta al usuario
    await enviarMensajeInstagram(senderId, botResponse);

    // 7. Actualizar timestamp de la conversación
    await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversation.id);
  } catch (error) {
    console.error('Error procesando mensaje:', error);
  }
}

async function generarRespuestaGemini(mensajeUsuario) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: mensajeUsuario,
    });
    return response.text;
  } catch (error) {
    console.error('Error Gemini:', error.message);
    return 'Estamos teniendo mucha demanda ahorita, dame un momento y te respondo 🙏';
  }
}

async function enviarMensajeInstagram(recipientId, texto) {
  const url = `https://graph.instagram.com/v21.0/me/messages`;
  try {
    await axios.post(
      url,
      { recipient: { id: recipientId }, message: { text: texto } },
      { params: { access_token: process.env.INSTAGRAM_TOKEN } }
    );
  } catch (error) {
    console.error('Error Facebook:', error.response?.data?.error?.message);
  }
}
