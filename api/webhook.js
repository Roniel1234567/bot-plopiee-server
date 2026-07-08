import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Inicialización de Gemini con la nueva librería
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  // 1. VALIDACIÓN DEL WEBHOOK (GET)
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // 2. RECEPCIÓN DE MENSAJES (POST)
  if (req.method === 'POST') {
    try {
      const messaging = req.body.entry?.[0]?.messaging?.[0];
      
      // Verificamos que sea un mensaje y tenga texto
      if (messaging?.message?.text && messaging.sender?.id) {
        const senderId = messaging.sender.id;
        const userMessage = messaging.message.text;

        // Generamos la respuesta y enviamos
        const botResponse = await generarRespuestaGemini(userMessage);
        await enviarMensajeInstagram(senderId, botResponse);
      }
      
      // Respondemos siempre 200 a Meta para que no reintente
      return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
      console.error('ERROR EN POST:', error.message);
      return res.status(200).send('EVENT_RECEIVED'); 
    }
  }

  return res.status(405).send('Method Not Allowed');
}

async function generarRespuestaGemini(texto) {
  try {
    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(texto);
    return result.response.text();
  } catch (error) {
    console.error("Error Gemini:", error.message);
    return "Lo siento, tuve un problema técnico con la IA.";
  }
}

async function enviarMensajeInstagram(recipientId, texto) {
  const url = `https://graph.facebook.com/v21.0/me/messages`;
  try {
    await axios.post(url, 
      { 
        recipient: { id: recipientId }, 
        message: { text: texto } 
      },
      { 
        params: { access_token: process.env.INSTAGRAM_TOKEN } 
      }
    );
    console.log("Mensaje enviado con éxito a:", recipientId);
  } catch (error) {
    console.error("Error al enviar a Instagram:", error.response?.data?.error?.message || error.message);
  }
}
