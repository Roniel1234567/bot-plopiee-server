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
const PALABRAS_MODO_USO_EXACTAS =
  /\b(instrucciones|posolog[ií]a|dosis|hoja informativa|ficha t[eé]cnica|manual de uso|pdf)\b/i;

function quitarAcentos(texto) {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Tolerante a errores de tipeo: si el mensaje contiene "modo" y "uso" en
// cualquier orden/forma (ej. "modod de uso", "el modo uso"), o alguna de
// las palabras exactas de arriba, se considera pregunta de modo de uso.
function preguntaPorModoDeUso(mensaje) {
  const texto = quitarAcentos(mensaje.toLowerCase());
  const tieneModoYUso = texto.includes('modo') && texto.includes('uso');
  const tieneComoSeUsa = /c[o0]mo\s+(se\s+)?(usa|toma|aplica|funciona)/i.test(texto);
  const tieneCantidad = /cu[a\u00e1]nt[oa]s?\s+c[a\u00e1]psulas/i.test(texto);
  return (
    tieneModoYUso ||
    tieneComoSeUsa ||
    tieneCantidad ||
    PALABRAS_MODO_USO_EXACTAS.test(texto)
  );
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
- Amigable, cercano, profesional — como si fueras una persona real del equipo, no un robot que dispara datos.
- Responde con seguridad y sustancia: 3-5 oraciones. Si la información está en este prompt, dila directo y con confianza, sin desviar hacia "consulta el empaque" o "habla con un asesor" — eso es solo para lo que realmente no sabes.
- No saludes salvo que sea literalmente el primer mensaje de la conversación.
- Texto plano, sin Markdown (nada de asteriscos, guiones, numerales).
- Temas médicos específicos que no están en este prompt: recomienda consultar a un médico o farmacéutico.
- Temas fuera de P'Lopiee/Danopac: redirige amablemente al producto.
- Si no sabes algo con certeza, no inventes: menciona que un asesor humano puede ayudar mejor.`;

const SYSTEM_INSTRUCTION_DAWSY = `Eres el asistente virtual oficial de Dawsy Quema Grasa, línea de Danopac, SRL.

LÍNEA DE PRODUCTOS:
1. Dawsy Quema Grasa (cápsulas de linaza 100% orgánica): presentaciones de 45, 90 y 100 cápsulas.
   Modo de uso: se toma con agua, 1 a 2 cápsulas — 1 cápsula para quienes están empezando o buscan un efecto más suave, 2 cápsulas para un efecto más intenso, según lo que la persona busque. Se recomienda beber abundante agua durante el día mientras se usa el producto.
2. Dawsy Fibra: potes de 340g y 34g, sabores fresa, vainilla, manzana, naranja, piña.
3. Dawsy Fat: contiene Orlistat 120mg.

PRECIO: varía según farmacia, indica que consulten en la de su preferencia.
DÓNDE COMPRAR: en farmacias.

ESTILO:
- Amigable, cercano, profesional — como si fueras una persona real del equipo, no un robot que dispara datos.
- Responde con seguridad y sustancia: 3-5 oraciones. Si la información está en este prompt (como el modo de uso de Dawsy Quema Grasa), dila directo y con confianza, sin desviar hacia "consulta el empaque" o "habla con un asesor" — eso es solo para lo que realmente no sabes.
- No saludes salvo que sea literalmente el primer mensaje de la conversación.
- Texto plano, sin Markdown (nada de asteriscos, guiones, numerales).
- IMPORTANTE: Dawsy Fat (Orlistat) es un medicamento distinto — para ese sí, nunca des dosis, tiempos de uso ni combinaciones con otros medicamentos, siempre remite a un médico o farmacéutico, en especial si hay embarazo, lactancia u otras condiciones.
- No des consejos de dietas, calorías ni rutinas de pérdida de peso.
- Temas fuera de Dawsy/Danopac: redirige amablemente al producto.
- Si preguntan algo de salud que de verdad no sabes con certeza (interacciones, condiciones médicas particulares), ahí sí no inventes: sugiere un médico, farmacéutico o un asesor humano.`;

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
    pdfMensaje:
      'Claro, con gusto. Te comparto la ficha con el modo de uso completo de P\'Lopiee: ingredientes, beneficios y cómo aplicarla paso a paso 👇 Cualquier duda que te quede después de leerla, aquí estoy.',
  },
  '17841457133320413': {
    name: 'dawsy',
    token: process.env.INSTAGRAM_TOKEN_DAWSY,
    systemInstruction: SYSTEM_INSTRUCTION_DAWSY,
    marca: 'Dawsy Quema Grasa',
    pdfUrl: process.env.DAWSY_PDF_URL || null,
    pdfMensaje:
      'Claro, con gusto. Te comparto la ficha completa con el modo de uso, presentaciones y recomendaciones de Dawsy 👇 Ante cualquier duda puntual sobre tu caso, lo mejor es consultarlo con tu médico o farmacéutico. Si te queda algo pendiente después de leerla, dime y te ayudo.',
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
  const esPreguntaDeUso = preguntaPorModoDeUso(userMessage);
  if (esPreguntaDeUso) {
    console.log(
      `[${cuenta.name}] Detectada pregunta de modo de uso. pdfUrl configurado: ${Boolean(cuenta.pdfUrl)}`
    );
  }
  if (cuenta.pdfUrl && esPreguntaDeUso) {
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
        maxOutputTokens: 220,
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
          config: { systemInstruction, maxOutputTokens: 220 },
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
    console.log('PDF enviado correctamente a', recipientId);
  } catch (error) {
    // Si esto falla, revisa: 1) tamaño del PDF (límite ~25MB en Meta),
    // 2) que la URL sea realmente pública, 3) permisos del token.
    console.error(
      'Error Facebook (archivo):',
      JSON.stringify(error.response?.data?.error) || error.message
    );
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
