import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  // PRUEBA DE FUNCIONAMIENTO
  if (req.query.test === 'true') {
    try {
      // Usamos el modelo que SIEMPRE existe en cuentas gratuitas
      const model = genAI.getGenerativeModel({ model: "gemini-pro" });
      const result = await model.generateContent("Hola, responde 'Conectado'");
      return res.status(200).send("Resultado: " + result.response.text());
    } catch (e) {
      return res.status(500).send("Error crítico: " + e.message);
    }
  }

  // Lógica normal
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send('Forbidden');
  }

  if (req.method === 'POST') {
    try {
      const messaging = req.body.entry?.[0]?.messaging?.[0];
      if (messaging?.message?.text && messaging.sender?.id) {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const result = await model.generateContent(messaging.message.text);
        await enviarMensajeInstagram(messaging.sender.id, result.response.text());
      }
      return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
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
