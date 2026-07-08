import axios from 'axios';

export default async function handler(req, res) {
  
  // PRUEBA DE FUNCIONAMIENTO FORZADA
  if (req.query.test === 'true') {
    try {
      const respuesta = await generarRespuestaGemini("Hola, dime si funcionas");
      return res.status(200).send("Resultado: " + respuesta);
    } catch (e) {
      return res.status(500).send("Error crítico: " + e.message);
    }
  }

  // VALIDACIÓN DEL WEBHOOK (GET)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // RECEPCIÓN DE MENSAJES (POST)
  if (req.method === 'POST') {
    try {
      const messaging = req.body.entry?.[0]?.messaging?.[0];
      
      if (messaging?.message?.text && messaging.sender?.id) {
        const botResponse = await generarRespuestaGemini(messaging.message.text);
        await enviarMensajeInstagram(messaging.sender.id, botResponse);
      }
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
    // CAMBIO CLAVE: Usamos la versión estable 'v1' en lugar de 'v1beta'
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    const response = await axios.post(url, {
      contents: [{ parts: [{ text: texto }] }]
    });

    return response.data.candidates[0].content.parts[0].text;
  } catch (error) {
    return "Error técnico directo: " + (error.response?.data?.error?.message || error.message);
  }
}

async function enviarMensajeInstagram(recipientId, texto) {
  const url = `https://graph.facebook.com/v21.0/me/messages`;
  try {
    await axios.post(url, 
      { recipient: { id: recipientId }, message: { text: texto } },
      { params: { access_token: process.env.INSTAGRAM_TOKEN } }
    );
  } catch (error) {
    console.error("Error al enviar a Instagram:", error.response?.data?.error?.message || error.message);
  }
}
