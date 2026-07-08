import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Inicialización
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  // 1. DIAGNÓSTICO
  if (req.query.test === 'true') {
    try {
      // Usamos el modelo específico para API gratuita
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
      const result = await model.generateContent("Hola, responde 'Funcionando'");
      return res.status(200).send("Gemini respondió: " + result.response.text());
    } catch (e) {
      return res.status(500).send("Error crítico: " + e.message);
    }
  }

  // 2. WEBHOOK NORMAL
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send('Forbidden');
  }

  if (req.method === 'POST') {
    try {
      const messaging = req.body.entry?.[0]?.messaging?.[0];
      if (messaging?.message?.text && messaging.sender?.id) {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
        const result = await model.generateContent(messaging.message.text);
        await enviarMensajeInstagram(messaging.sender.id, result.response.text());
      }
      return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
      console.error('ERROR:', error.message);
      return res.status(200).send('EVENT_RECEIVED');
    }
  }
}

async function enviarMensajeInstagram(recipientId, texto) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/me/messages`, 
      { recipient: { id: recipientId }, message: { text: texto } },
      { params: { access_token: process.env.INSTAGRAM_TOKEN } }
    );
  } catch (error) {
    console.error("Error Instagram:", error.message);
  }
}
