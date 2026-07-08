import axios from 'axios';
import { GoogleGenAI } from '@google/genai';

// Inicialización
const ai = new GoogleGenAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  // 1. VALIDACIÓN DEL WEBHOOK (GET)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // 2. RECEPCIÓN DE MENSAJES (POST)
  if (req.method === 'POST') {
    try {
      // Log para verificar qué llega exactamente
      console.log("Cuerpo recibido:", JSON.stringify(req.body));
      
      const { entry } = req.body;

      if (entry && entry[0].messaging && entry[0].messaging[0]) {
        const messaging = entry[0].messaging[0];
        const senderId = messaging.sender?.id;
        const userMessage = messaging.message?.text;

        if (userMessage && senderId) {
          console.log(`Procesando mensaje de ${senderId}: ${userMessage}`);
          const botResponse = await generarRespuestaGemini(userMessage);
          await enviarMensajeInstagram(senderId, botResponse);
        }
      }
      
      return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
      // Registro de error detallado para Vercel Logs
      console.error('ERROR DETALLADO:', error.stack || error.message);
      return res.status(500).send('Error Interno');
    }
  }

  return res.status(405).send('Method Not Allowed');
}

async function generarRespuestaGemini(mensajeUsuario) {
  try {
    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(mensajeUsuario);
    return result.response.text();
  } catch (error) {
    console.error("Error Gemini:", error.message);
    return "Lo siento, tuve un error al procesar tu solicitud.";
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
    console.log("Mensaje enviado exitosamente a:", recipientId);
  } catch (error) {
    // Si falla, veremos la respuesta exacta de Facebook en los logs
    console.error("Error detallado de Facebook:", error.response?.data || error.message);
    throw error;
  }
}
