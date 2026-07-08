import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  if (req.query.test === 'true') {
    try {
      // Pedimos a la API que nos liste los modelos disponibles
      const models = await genAI.listModels();
      const modelNames = models.models.map(m => m.name).join(', ');
      return res.status(200).send("Modelos disponibles: " + modelNames);
    } catch (e) {
      return res.status(500).send("Error al listar modelos: " + e.message);
    }
  }
  return res.status(200).send("Bot activo");
}
