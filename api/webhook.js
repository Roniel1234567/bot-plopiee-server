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
      if (entry?.[0]?.messaging?.[0]) {
        const messaging = entry[0].messaging[0];
        const senderId = messaging.sender?.id;
        const userMessage = messaging.message?.text;
        if (userMessage && senderId) {
          const botResponse = await generarRespuestaGemini(userMessage);
          await enviarMensajeInstagram(senderId, botResponse);
        }
      } else {
        console.log('NO SE ENCONTRO messaging[0] EN LA ESTRUCTURA ESPERADA');
      }
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
