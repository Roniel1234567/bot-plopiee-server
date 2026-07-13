import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const PALABRAS_HUMANO = ['humano', 'agente', 'persona', 'asesor', 'operador', 'representante'];

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
        return res.status(200).send('EVENT_RECEIVED');
      }

      if (!senderId || !userMessage || !wamid) {
        return res.status(200).send('EVENT_RECEIVED');
      }

      waitUntil(procesarMensaje({ senderId, userMessage, wamid }));

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
    // 1. Buscar o crear la conversación
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

    // 2. Guardar mensaje del usuario (deduplicación)
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

    // 3. Si ya está en modo humano, no responde el bot
    if (conversation.is_human) {
      console.log('Conversación en modo humano, bot no responde:', senderId);
      return;
    }

    // 4. Detectar si el usuario pide un humano
    const pideHumano = PALABRAS_HUMANO.some((palabra) =>
      userMessage.toLowerCase().includes(palabra)
    );

    if (pideHumano) {
      // Activar bandera is_human
      await supabase
        .from('conversations')
        .update({ is_human: true, updated_at: new Date().toISOString() })
        .eq('id', conversation.id);

      const mensajeConfirmacion = 'Listo, en un momento un asesor te atiende 🙌';

      await supabase.from('messages').insert({
        conversation_id: conversation.id,
        wa_message_id: `bot_${wamid}`,
        role: 'bot',
        content: mensajeConfirmacion,
      });

      await enviarMensajeInstagram(senderId, mensajeConfirmacion);
      await notificarWhatsApp(senderId);
      return;
    }

    // 5. Generar respuesta con Gemini
    const botResponse = await generarRespuestaGemini(userMessage);

    // 6. Guardar respuesta del bot
    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      wa_message_id: `bot_${wamid}`,
      role: 'bot',
      content: botResponse,
    });

    // 7. Enviar respuesta al usuario
    await enviarMensajeInstagram(senderId, botResponse);

    // 8. Actualizar timestamp
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

async function notificarWhatsApp(senderId) {
  const texto = encodeURIComponent(
    `🔔 Un usuario de Instagram (ID: ${senderId}) pidió hablar con un humano. Revisa el chat.`
  );

  const notificaciones = [
    { phone: process.env.WHATSAPP_NOTIFY_1_PHONE, apikey: process.env.WHATSAPP_NOTIFY_1_APIKEY },
    { phone: process.env.WHATSAPP_NOTIFY_2_PHONE, apikey: process.env.WHATSAPP_NOTIFY_2_APIKEY },
  ];

  for (const n of notificaciones) {
    if (!n.phone || !n.apikey) continue;
    try {
      await axios.get(
        `https://api.callmebot.com/whatsapp.php?phone=${n.phone}&text=${texto}&apikey=${n.apikey}`
      );
    } catch (error) {
      console.error(`Error notificando a ${n.phone}:`, error.message);
    }
  }
}
