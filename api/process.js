import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import { Receiver } from '@upstash/qstash';

export const config = {
  api: {
    bodyParser: false,
  },
};

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

const PALABRAS_HUMANO = ['humano', 'agente', 'persona', 'asesor', 'operador', 'representante'];

const SYSTEM_INSTRUCTION_PLOPIEE = `Eres el asistente virtual oficial de P'Lopiee, un producto de la empresa Danopac, SRL.

SOBRE EL PRODUCTO:
P'Lopiee es una crema mentolada con Castaño de Indias y extracto de Hamamelis, especializada para el cuidado de los pies y las piernas. Está formulada para aliviar molestias como cansancio, hinchazón, sensación de pesadez, tensión muscular y várices.

INGREDIENTES CLAVE Y BENEFICIOS:
- Extracto de Hamamelis Virginiana: astringente, antiinflamatorio y calmante. Reduce la inflamación, el enrojecimiento y la irritación, y tonifica y refresca la piel.
- Extracto de Castaño de Indias: vasoprotector y descongestivo. Favorece la microcirculación, fortalece las venas y reduce la sensación de pesadez, hinchazón y fatiga.
- Mentol: refrescante, calmante y descongestionante. Genera una sensación inmediata de frescor que alivia la incomodidad, el cansancio y la tensión muscular/cutánea, revitalizando la piel.
- Diclofenaco: antiinflamatorio no esteroideo (AINE) y analgésico. Reduce la inflamación localizada y alivia el dolor causado por tensión muscular, golpes o fatiga, mejorando el confort y la movilidad.

BENEFICIOS GENERALES:
- Alivia el cansancio y pesadez de piernas y pies.
- Ayuda con la sensación de várices y mala circulación.
- Antiinflamatorio y calmante para golpes o tensión muscular.
- Efecto refrescante inmediato gracias al mentol.

PRECIO:
El precio puede variar según el punto de venta. Si te preguntan cuánto cuesta, indica amablemente que deben consultar el precio en su farmacia más cercana o de su confianza, ya que puede variar.

DÓNDE COMPRARLO:
Disponible en farmacias.

TU ESTILO DE RESPUESTA:
- Responde de forma amigable, cercana y profesional, como si fueras parte del equipo de atención al cliente de Danopac.
- Sé breve y claro, evita respuestas muy largas.
- IMPORTANTE - SALUDOS: NO empieces cada respuesta con un saludo tipo "Hola". Responde directo, como en una conversación ya iniciada. Solo saluda si es literalmente el primer mensaje de la conversación.
- IMPORTANTE - FORMATO: escribe en texto plano, sin Markdown (nada de asteriscos, guiones de lista, numerales, etc.).
- Si preguntan algo médico muy específico, recomiéndales consultar con un médico o farmacéutico.
- Si preguntan algo que no tiene nada que ver con P'Lopiee o Danopac, redirige amablemente hacia el producto.
- Si no sabes algo con certeza, no inventes información — menciona que un asesor humano puede ayudarles mejor.`;

const SYSTEM_INSTRUCTION_DAWSY = `Eres el asistente virtual oficial de Dawsy Quema Grasa, una línea de productos de la empresa Danopac, SRL.

SOBRE LA LÍNEA DE PRODUCTOS:
Dawsy es una línea de productos para apoyar la pérdida de peso, de la empresa Danopac. Incluye varias presentaciones:

1. Dawsy Quema Grasa (cápsulas de linaza 100% orgánica): disponible en presentaciones de 45, 90 y 100 cápsulas.
2. Dawsy Fibra: en potes de 340g y 34g, en varios sabores (fresa, vainilla, manzana, naranja, piña).
3. Dawsy Fat: contiene Orlistat 120mg.
4. Dawlax: contiene Picosulfato de sodio 7.5mg/ml, presentado en sobres, es un laxante.

Todos estos productos son parte de la línea para bajar de peso de Danopac, SRL.

PRECIO:
El precio puede variar según el punto de venta. Si preguntan cuánto cuesta, indica amablemente que deben consultar el precio en su farmacia más cercana o de su confianza.

DÓNDE COMPRARLO:
Disponible en farmacias.

TU ESTILO DE RESPUESTA:
- Responde de forma amigable, cercana y profesional, como parte del equipo de atención al cliente de Danopac.
- Sé breve y claro, evita respuestas muy largas.
- IMPORTANTE - SALUDOS: NO empieces cada respuesta con un saludo tipo "Hola". Responde directo, como en una conversación ya iniciada. Solo saluda si es literalmente el primer mensaje de la conversación.
- IMPORTANTE - FORMATO: escribe en texto plano, sin Markdown (nada de asteriscos, guiones de lista, numerales, etc.).
- IMPORTANTE - RESPONSABILIDAD MÉDICA: Dawsy Fat (Orlistat) y Dawlax (Picosulfato) son medicamentos, no suplementos simples. Nunca des indicaciones de dosis, tiempos de uso, ni combinaciones con otros medicamentos. Siempre recomienda consultar con un médico o farmacéutico antes de usarlos, especialmente si la persona tiene alguna condición de salud, está embarazada, en lactancia, o toma otros medicamentos.
- No des consejos de dietas, calorías específicas, ni rutinas de pérdida de peso — enfócate solo en explicar qué es cada producto y sus características, y remite temas de salud o nutrición a un profesional.
- Si preguntan algo que no tiene nada que ver con Dawsy o Danopac, redirige amablemente hacia el producto.
- Si no sabes algo con certeza, no inventes información — menciona que un asesor humano puede ayudarles mejor.`;

const ACCOUNTS = {
  '17841477353996766': {
    name: 'plopiee',
    token: process.env.INSTAGRAM_TOKEN,
    systemInstruction: SYSTEM_INSTRUCTION_PLOPIEE,
    marca: "P'Lopiee",
  },
  '17841457133320413': {
    name: 'dawsy',
    token: process.env.INSTAGRAM_TOKEN_DAWSY,
    systemInstruction: SYSTEM_INSTRUCTION_DAWSY,
    marca: 'Dawsy Quema Grasa',
  },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers['upstash-signature'];

  try {
    const isValid = await receiver.verify({
      signature,
      body: rawBody,
      url: `${process.env.APP_URL}/api/process`,
    });
    if (!isValid) {
      console.error('Firma de QStash inválida');
      return res.status(401).send('Invalid signature');
    }
  } catch (error) {
    console.error('Error verificando firma QStash:', error.message);
    return res.status(401).send('Invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    return res.status(400).send('Bad request');
  }

  try {
    await procesarMensaje(payload);
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error procesando mensaje:', error);
    return res.status(500).send('Error interno');
  }
}

async function procesarMensaje({ senderId, userMessage, wamid, conversationId, accountId }) {
  const cuenta = ACCOUNTS[accountId];

  if (!cuenta) {
    console.error('Cuenta de Instagram no reconocida:', accountId);
    return;
  }

  const pideHumano = PALABRAS_HUMANO.some((palabra) =>
    userMessage.toLowerCase().includes(palabra)
  );

  if (pideHumano) {
    await supabase
      .from('conversations')
      .update({ is_human: true, updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    const mensajeConfirmacion = 'Listo, en un momento un asesor te atiende 🙌';

    await supabase.from('messages').insert({
      conversation_id: conversationId,
      wa_message_id: `bot_${wamid}`,
      role: 'bot',
      content: mensajeConfirmacion,
    });

    await enviarMensajeInstagram(senderId, mensajeConfirmacion, cuenta.token);
    await notificarWhatsApp(senderId, userMessage, cuenta);
    return;
  }

  const botResponse = await generarRespuestaGemini(userMessage, cuenta.systemInstruction);

  await supabase.from('messages').insert({
    conversation_id: conversationId,
    wa_message_id: `bot_${wamid}`,
    role: 'bot',
    content: botResponse,
  });

  await enviarMensajeInstagram(senderId, botResponse, cuenta.token);

  await supabase
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);
}

async function generarRespuestaGemini(mensajeUsuario, systemInstruction) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: mensajeUsuario,
      config: {
        systemInstruction,
      },
    });
    return response.text;
  } catch (error) {
    const esErrorDeCuota =
      error.message?.includes('429') || error.message?.includes('RESOURCE_EXHAUSTED');

    if (esErrorDeCuota) {
      console.log('Cuota excedida, esperando 5 segundos para reintentar...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      try {
        const retryResponse = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: mensajeUsuario,
          config: { systemInstruction },
        });
        return retryResponse.text;
      } catch (retryError) {
        console.error('Error Gemini (reintento falló):', retryError.message);
        return 'Estamos teniendo mucha demanda ahorita, dame un momento y te respondo 🙏';
      }
    }

    console.error('Error Gemini:', error.message);
    return 'Estamos teniendo mucha demanda ahorita, dame un momento y te respondo 🙏';
  }
}

async function enviarMensajeInstagram(recipientId, texto, token) {
  const url = `https://graph.instagram.com/v21.0/me/messages`;
  try {
    await axios.post(
      url,
      { recipient: { id: recipientId }, message: { text: texto } },
      { params: { access_token: token } }
    );
  } catch (error) {
    console.error('Error Facebook:', error.response?.data?.error?.message);
  }
}

async function obtenerNombreUsuario(senderId, token) {
  try {
    const response = await axios.get(
      `https://graph.instagram.com/${senderId}`,
      {
        params: {
          fields: 'name,username',
          access_token: token,
        },
      }
    );
    return response.data.username || response.data.name || senderId;
  } catch (error) {
    console.error('Error obteniendo nombre de usuario:', error.response?.data?.error?.message);
    return senderId;
  }
}

async function notificarWhatsApp(senderId, mensajeUsuario, cuenta) {
  const nombreUsuario = await obtenerNombreUsuario(senderId, cuenta.token);

  const texto = encodeURIComponent(
    `🔔 ${cuenta.marca} (Instagram)\n\nCliente: ${nombreUsuario}\nMensaje: "${mensajeUsuario}"\n\nPidió hablar con un asesor. Entra a Instagram para atenderlo.`
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
