import axios from 'axios';

// YA NO USAMOS EL SDK PORQUE ESTÁ FALLANDO LA RUTA
// Haremos la petición directa a la API usando axios
export default async function handler(req, res) {
  
  // PRUEBA DE FUNCIONAMIENTO
  if (req.query.test === 'true') {
    try {
      const respuesta = await generarRespuestaGemini("Hola, dime si funcionas");
      return res.status(200).send("Resultado: " + respuesta);
    } catch (e) {
      return res.status(500).send("Error crítico: " + e.message);
    }
  }

  // Lógica normal de Webhook (POST y GET)...
  // (Mantén aquí el resto de tu código igual)
}

async function generarRespuestaGemini(texto) {
  try {
    // LLAMADA DIRECTA A LA API (SIN EL SDK)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    const response = await axios.post(url, {
      contents: [{ parts: [{ text: texto }] }]
    });

    return response.data.candidates[0].content.parts[0].text;
  } catch (error) {
    return "Error técnico directo: " + (error.response?.data?.error?.message || error.message);
  }
}
