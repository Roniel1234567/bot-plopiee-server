import axios from 'axios';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
      console.log('BODY RECIBIDO:', JSON.stringify(req.body));
      const { entry } = req.body;
      const entryItem = entry?.[0];

      // Caso 1: estructura real de mensajería (messaging)
      const messagingEvent = entryItem?.messaging?.[0];
      if (messagingEvent?.message?.text) {
        const senderId = messagingEvent.sender?.id;
        const userMessage = messagingEvent.message.text;
        const botResponse = await generarRespuestaGemini(userMessage);
        await enviarMensajeInstagram(senderId, botResponse);
        return res.status(200).send('EVENT_RECEIVED');
      }

      // Caso 2: estructura de "changes" (usada por el botón Test de Meta)
      const change = entryItem?.changes?.[0];
      if (change?.field === 'messages' && change.value?.message?.text) {
        const senderId = change.value.sender?.id;
        const userMessage = change.value.message.text;
        const botResponse = await generarRespuestaGemini(userMessage);
        await enviarMensajeInstagram(senderId, botResponse);
        return res.status(200).send('EVENT_RECEIVED');
      }

      console.log('Evento recibido sin texto de mensaje (probablemente read/delivery):', JSON.stringify(messagingEvent || change));
      return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
      console.error('ERROR DETALLADO:', error.stack);
      return res.status(500).send('Error');
    }
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
    return 'Error al procesar con IA.';
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
