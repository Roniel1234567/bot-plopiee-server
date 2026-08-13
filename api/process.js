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

// ─────────────────────────────────────────────────────────
// DETECCIÓN DE "QUIERE HABLAR CON UN HUMANO"
// ─────────────────────────────────────────────────────────
// Antes esto usaba .includes() sobre palabras sueltas ("persona",
// "operador", etc.), lo cual disparaba el modo humano con CUALQUIER
// mensaje que contuviera esa palabra en cualquier contexto
// (ej: "se la recomendé a otra persona"). Por eso llegaban al WhatsApp
// notificaciones que no eran solicitudes reales.
//
// Ahora se dividen en dos grupos:
// - Palabras fuertes: casi nunca aparecen fuera de este contexto,
//   así que disparan solas.
// - Palabras ambiguas: solo disparan si además hay un verbo de
//   solicitud en el mismo mensaje.
const PALABRAS_FUERTES = /\b(humano|agente|asesor)\b/i;
const PALABRAS_AMBIGUAS = /\b(persona|operador|representante)\b/i;
const VERBOS_SOLICITUD =
  /\b(hablar|quiero|necesito|comunicarme|contactar|pasar(me)?|conectar(me)?|atienda|atienda[nr]?)\b/i;

function pideHumano(mensaje) {
  const texto = mensaje.toLowerCase();
  if (PALABRAS_FUERTES.test(texto)) return true;
  if (PALABRAS_AMBIGUAS.test(texto) && VERBOS_SOLICITUD.test(texto)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────
// DETECCIÓN DE "PREGUNTA POR MODO DE USO / INSTRUCCIONES"
// ─────────────────────────────────────────────────────────
// Si el cliente pregunta por esto y la cuenta tiene un PDF configurado,
// respondemos con un mensaje fijo + el PDF, SIN llamar a Gemini.
// Esto ahorra la llamada completa a la API en ese tipo de pregunta.
const PALABRAS_MODO_USO =
  /\b(modo de uso|c[oó]mo se usa|c[oó]mo lo uso|c[oó]mo lo aplico|c[oó]mo aplicar|instrucciones|c[oó]mo (se )?toma|c[oó]mo tomarlo|posolog[ií]a|dosis|c[oó]mo funciona|hoja informativa|ficha t[eé]cnica)\b/i;

function preguntaPorModoDeUso(mensaje) {
  return PALABRAS_MODO_USO.test(mensaje.toLowerCase());
}

// ─────────────────────────────────────────────────────────
// SYSTEM PROMPTS (recortados para reducir tokens de entrada,
// con instrucción explícita de brevedad para reducir tokens de salida)
// ─────────────────────────────────────────────────────────
const SYSTEM_INSTRUCTION_PLOPIEE = `Eres el asistente virtual oficial de P'Lopiee, producto de Danopac, SRL.

PRODUCTO: Crema mentolada con Castaño de Indias y extracto de Hamamelis, para pies y piernas. Alivia cansancio, hinchazón, pesadez, tensión muscular y várices.

INGREDIENTES:
- Hamamelis Virginiana: astringente, antiinflamatorio, calma irritación y tonifica la piel.
- Castaño de Indias: vasoprotector, mejora la microcirculación, reduce pesadez e hinchazón.
- Mentol: efecto refrescante inmediato, alivia cansancio y tensión.
- Diclofenaco (AINE): reduce inflamación localizada y dolor por golpes o tensión muscular.

PRECIO: varía según farmacia, indica que consulten en la de su preferencia.
DÓNDE COMPRAR: en farmacias.

ESTILO:
- Amigable, cercano, profesional.
- MÁXIMO 2-3 oraciones cortas por respuesta. Ve directo al punto.
- No saludes salvo que sea literalmente el primer mensaje de la conversación.
- Texto plano, sin Markdown (nada de asteriscos, guiones, numerales).
- Temas médicos específicos: recomienda consultar a un médico o farmacéutico.
- Temas fuera de P'Lopiee/Danopac: redirige amablemente al producto.
- Si no sabes algo con certeza, no inventes: menciona que un asesor humano puede ayudar mejor.`;

const SYSTEM_INSTRUCTION_DAWSY = `Eres el asistente virtual oficial de Dawsy Quema Grasa, línea de Danopac, SRL.

LÍNEA DE PRODUCTOS:
1. Dawsy Quema Grasa (cápsulas de linaza 100% orgánica): presentaciones de 45, 90 y 100 cápsulas.
2. Dawsy Fibra: potes de 340g y 34g, sabores fresa, vainilla, manzana, naranja, piña.
3. Dawsy Fat: contiene Orlistat 120mg.
4. Dawlax: contiene Picosulfato de sodio 7.5mg/ml, en sobres, es laxante.

PRECIO: varía según farmacia, indica que consulten en la de su preferencia.
DÓNDE COMPRAR: en farmacias.

ESTILO:
- Amigable, cercano, profesional.
- MÁXIMO 2-3 oraciones cortas por respuesta. Ve directo al punto.
- No saludes salvo que sea literalmente el primer mensaje de la conversación.
- Texto plano, sin Markdown (nada de asteriscos, guiones, numerales).
- IMPORTANTE: Dawsy Fat (Orlistat) y Dawlax (Picosulfato) son medicamentos. Nunca des dosis, tiempos de uso ni combinaciones con otros medicamentos — siempre remite a un médico o farmacéutico, en especial si hay embarazo, lactancia u otras condiciones.
- No des consejos de dietas, calorías ni rutinas de pérdida de peso.
- Temas fuera de Dawsy/Danopac: redirige amablemente al producto.
- Si no sabes algo con certeza, no inventes: menciona que un asesor humano puede ayudar mejor.`;

// ─────────────────────────────────────────────────────────
// CONFIGURACIÓN DE CUENTAS
// ─────────────────────────────────────────────────────────
// pdfUrl y pdfMensaje son opcionales: si no hay PDF configurado para
// una cuenta, la pregunta de "modo de uso" se responde normal con IA.
const ACCOUNTS = {
  '17841477353996766': {
    name: 'plopiee',
    token: process.env.INSTAGRAM_TOKEN,
    systemInstruction: SYSTEM_INSTRUCTION_PLOPIEE,
    marca: "P'Lopiee",
    pdfUrl: process.env.PLOPIEE_PDF_URL || null,
    pdfMensaje: 'Claro, aquí tienes la ficha con el modo de uso de P\'Lopiee 👇',
  },
  '17841457133320413': {
    name: 'dawsy',
    token: process.env.INSTAGRAM_TOKEN_DAWSY,
    systemInstruction: SYSTEM_INSTRUCTION_DAWSY,
    marca: 'Dawsy Quema Grasa',
    pdfUrl: process.env.DAWSY_PDF_URL || null,
    pdfMensaje: 'Claro, aquí tienes la ficha con el modo de uso 👇 Recuerda que ante cualquier duda de salud lo mejor es consultar con tu médico o farmacéutico.',
  },
  // Cuando agregues TikTán u otro producto, solo agrega su entrada aquí:
  // 'ID_DE_INSTAGRAM_AQUI': {
  //   name: 'tiktan',
  //   token: process.env.INSTAGRAM_TOKEN_TIKTAN,
  //   systemInstruction: SYSTEM_INSTRUCTION_TIKTAN,
  //   marca: 'TikTán',
  //   pdfUrl: process.env.TIKTAN_PDF_URL || null,
  //   pdfMensaje: 'Claro, aquí tienes la ficha con el modo de uso 👇',
  // },
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

  // 1) ¿Pide hablar con un humano?
  if (pideHumano(userMessage)) {
    await escalarAHumano({ senderId, userMessage, wamid, conversationId, cuenta });
    return;
  }

  // 2) ¿Pregunta por modo de uso y hay PDF configurado? -> responde sin llamar a Gemini
  if (cuenta.pdfUrl && preguntaPorModoDeUso(userMessage)) {
    await responderConPDF({ senderId, wamid, conversationId, cuenta });
    return;
  }

  // 3) Caso normal: responde con IA
  const botResponse = await generarRespuestaGemini(userMessage, cuenta.systemInstruction);
  await guardarYEnviar({ senderId, wamid, conversationId, cuenta, texto: botResponse });
}

async function escalarAHumano({ senderId, userMessage, wamid, conversationId, cuenta }) {
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
}

async function responderConPDF({ senderId, wamid, conversationId, cuenta }) {
  await guardarYEnviar({ senderId, wamid, conversationId, cuenta, texto: cuenta.pdfMensaje });
  await enviarArchivoInstagram(senderId, cuenta.pdfUrl, cuenta.token);
}

async function guardarYEnviar({ senderId, wamid, conversationId, cuenta, texto }) {
  await supabase.from('messages').insert({
    conversation_id: conversationId,
    wa_message_id: `bot_${wamid}`,
    role: 'bot',
    content: texto,
  });

  await enviarMensajeInstagram(senderId, texto, cuenta.token);

  await supabase
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);
}

async function generarRespuestaGemini(mensajeUsuario, systemInstruction) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: mensajeUsuario,
      config: {
        systemInstruction,
        maxOutputTokens: 130,
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
          model: 'gemini-3.1-flash-lite',
          contents: mensajeUsuario,
          config: { systemInstruction, maxOutputTokens: 130 },
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
    console.error('Error Facebook (texto):', error.response?.data?.error?.message);
  }
}

// Envía un archivo (ej. PDF) usando la Send API de Instagram.
// Requiere una URL pública (ej. un bucket público de Supabase Storage).
async function enviarArchivoInstagram(recipientId, fileUrl, token) {
  const url = `https://graph.instagram.com/v21.0/me/messages`;
  try {
    await axios.post(
      url,
      {
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: 'file',
            payload: { url: fileUrl, is_reusable: true },
          },
        },
      },
      { params: { access_token: token } }
    );
  } catch (error) {
    console.error('Error Facebook (archivo):', error.response?.data?.error?.message);
  }
}

async function obtenerNombreUsuario(senderId, token) {
  try {
    const response = await axios.get(`https://graph.instagram.com/${senderId}`, {
      params: {
        fields: 'name,username',
        access_token: token,
      },
    });
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
