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
const PALABRAS_MODO_USO_EXACTAS =
  /\b(instrucciones|posolog[ií]a|dosis|hoja informativa|ficha t[eé]cnica|manual de uso|pdf)\b/i;

function quitarAcentos(texto) {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

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
// CONFIRMACIÓN DE "SÍ, MÁNDAME LA FICHA" (cuando el bot la ofreció antes)
// ─────────────────────────────────────────────────────────
// Confirmación corta y flexible: cubre "sí", "dale", "envíamela porfa",
// "mándala", etc. Limitado a mensajes cortos para no disparar por error
// en preguntas largas que casualmente contengan alguna de estas palabras.
function esConfirmacionCorta(mensaje) {
  const texto = quitarAcentos(mensaje.trim().toLowerCase());
  if (texto.length === 0 || texto.length > 35) return false;

  const tieneAfirmativa =
    /\b(si|sisi|dale|va|vale|ok|okay|claro|porfa|por\s*favor|de una)\b/.test(texto);
  const tienePeticionDeEnvio =
    /\b(env[i]?a(mela|la|melo)?|mand[a]?(mela|la|melo)?|compart[ei](la|mela)?)\b/.test(texto);

  return tieneAfirmativa || tienePeticionDeEnvio;
}

// Revisa el último mensaje que el BOT envió en esta conversación para
// saber si ya había ofrecido la ficha/guía. Así, cuando el cliente
// responde solo "sí", sabemos a qué se refiere sin tener que mandarle
// el historial completo a Gemini en cada llamada (eso subiría el costo).
async function elBotOfrecioLaFichaAntes(conversationId) {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('content, role, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error || !data) return false;

    const ultimoDelBot = data.find((m) => m.role === 'bot');
    if (!ultimoDelBot) return false;

    const texto = quitarAcentos(ultimoDelBot.content.toLowerCase());
    return /\b(ficha|guia|pdf|documento)\b/.test(texto);
  } catch (error) {
    console.error('Error revisando historial para confirmación de ficha:', error.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────
// SYSTEM PROMPTS
// ─────────────────────────────────────────────────────────
const ESTILO_BASE_CALIDEZ = `- Habla como una persona real y cercana, no como un robot que solo dispara datos. Usa de vez en cuando (no en cada mensaje, para que no suene forzado ni repetitivo) expresiones cálidas dominicanas como "con mucho gusto", "será un placer ayudarte", "claro que sí", "cuenta conmigo". Puedes usar un trato cariñoso ocasional como "hermosa" o "amiga/o" si el tono de la conversación se siente natural para eso, pero nunca lo fuerces, no lo repitas en cada respuesta, y si el cliente pide un trato más formal o parece incómodo, cámbialo de inmediato a un trato neutral y profesional.`;

// Se agrega SOLO a las cuentas que sí tienen un PDF configurado (ver
// construirInstruccion más abajo), para que la IA nunca ofrezca un
// archivo que en realidad no existe.
const INSTRUCCION_OFRECER_FICHA = `

ADEMÁS: Existe una ficha técnica completa en PDF de este producto. Cuando le des al cliente una respuesta con bastante detalle sobre ingredientes, beneficios o modo de uso, puedes ofrecerle de forma natural, variada y espontánea (nunca en cada mensaje, nunca con la misma frase dos veces) que le compartes esa ficha completa si le interesa -por ejemplo preguntando si quiere que se la envíes-. No la envíes tú misma con solo mencionarla, no digas que ya se la mandaste ni actúes como si el archivo ya estuviera adjunto: solo ofrécela conversacionalmente. El sistema se encarga de mandarla en automático cuando el cliente confirme que la quiere.`;

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
${ESTILO_BASE_CALIDEZ}
- ADAPTACIÓN DE LONGITUD: Analiza siempre lo que dice el cliente antes de responder. Si el cliente te manda un saludo simple (como "hola", "buenas", "hola qué tal"), una pregunta aislada muy breve o una interacción corta, responde de forma breve, natural y directa (1 o 2 oraciones máximo), sin soltar explicaciones largas ni presionar con información innecesaria. Si el cliente pregunta algo complejo, técnico o pide detalles del producto, entonces sí despliega una respuesta más completa (4-7 oraciones organizadas en párrafos cortos).
- Nunca repitas la misma frase textual de una conversación a otra para preguntas parecidas — reformula, varía el orden, varía las palabras, suena natural y espontáneo cada vez.
- Si la respuesta larga tiene varias ideas, organízalas en 2-3 párrafos cortos separados por saltos de línea. Nunca uses asteriscos, guiones de lista, numerales ni ningún símbolo de Markdown — en este chat se ven literalmente como símbolos sueltos, no como formato.
- Si la información está en este prompt, dila directo y con confianza, sin desviar hacia "consulta el empaque" o "habla con un asesor" — eso es solo para lo que realmente no sabes.
- No saludes con un saludo largo de bienvenida salvo que sea estrictamente necesario en el primer mensaje.
- Temas médicos específicos que no están en este prompt: recomienda consultar a un médico o farmacéutico.
- Temas fuera de P'Lopiee/Danopac: redirige amablemente al producto.
- Si no sabes algo con certeza, no inventes: menciona que un asesor humano puede ayudar mejor.`;

const SYSTEM_INSTRUCTION_DAWSY = `Eres el asistente virtual oficial de Dawsy Quema Grasa, línea de Danopac, SRL.

LÍNEA DE PRODUCTOS:
1. Dawsy Quema Grasa (cápsulas de linaza 100% orgánica): presentaciones de 45, 90 y 100 cápsulas.
   Modo de uso: se toma con agua. Para un efecto más suave: 2 cápsulas al día. Para un efecto más potente: 2 cápsulas cada 12 horas (4 cápsulas al día en total). Se recomienda beber abundante agua durante el día mientras se usa el producto.
2. Dawsy Fibra: potes de 340g y 34g, sabores fresa, vainilla, manzana, naranja, piña.
3. Dawsy Fat: contiene Orlistat 120mg.

PRECIO: varía según farmacia, indica que consulten en la de su preferencia.
DÓNDE COMPRAR: en farmacias.

ESTILO:
- Amigable, cercano, profesional — como si fueras una persona real del equipo, no un robot que dispara datos.
${ESTILO_BASE_CALIDEZ}
- ADAPTACIÓN DE LONGITUD: Analiza siempre lo que dice el cliente antes de responder. Si el cliente te manda un saludo simple (como "hola", "buenas", "hola qué tal"), una pregunta aislada muy breve o una interacción corta, responde de forma breve, natural y directa (1 o 2 oraciones máximo), sin soltar explicaciones largas ni presionar con información innecesaria. Si el cliente pregunta algo complejo, técnico o pide detalles del producto, entonces sí despliega una respuesta más completa (4-7 oraciones organizadas en párrafos cortos).
- Nunca repitas la misma frase textual de una conversación a otra para preguntas parecidas — reformula, varía el orden, varía las palabras, suena natural y espontáneo cada vez.
- Si la respuesta larga tiene varias ideas (ej. modo de uso + recomendación + beneficio), organízalas en 2-3 párrafos cortos separados por saltos de línea. Nunca uses asteriscos, guiones de lista, numerales ni ningún símbolo de Markdown — en este chat se ven literalmente como símbolos sueltos, no como formato.
- Si la información está en este prompt, dila directo y con confianza, sin desviar hacia "consulta el empaque" o "habla con un asesor" — eso es solo para lo que realmente no sabes.
- No saludes con un saludo largo de bienvenida salvo que sea estrictamente necesario en el primer mensaje.
- IMPORTANTE: Dawsy Fat (Orlistat) es un medicamento distinto — para ese sí, nunca des dosis, tiempos de uso ni combinaciones con otros medicamentos, siempre remite a un médico o farmacéutico, en especial si hay embarazo, lactancia u otras condiciones.
- No des consejos de dietas, calorías ni rutinas de pérdida de peso.
- Temas fuera de Dawsy/Danopac: redirige amablemente al producto.
- Si preguntan algo de salud que de verdad no sabes con certeza (interacciones, condiciones médicas particulares), ahí sí no inventes: sugiere un médico, farmacéutico o un asesor humano.`;

const SYSTEM_INSTRUCTION_DAWRELY = `Eres el asistente virtual oficial de Dawrely, línea de cuidado íntimo femenino de Danopac, SRL.

LÍNEA DE PRODUCTOS (Jabones de lavado íntimo de uso externo):
1. Dawrely Fem: Formulado con Ácido Láctico. Realiza una limpieza suave, acompaña el cuidado del equilibrio natural de la zona y brinda sensación de frescura.
2. Dawrely Straits: Formulado con Alumbre. Limpia suavemente, ayuda a mantener un tono de piel más uniforme, y proporciona sensación de firmeza y estrechez gracias al alumbre.

MODO DE USO GENERAL:
De uso diario y exclusivamente externo. Humedecer la zona íntima externa con agua, aplicar una pequeña cantidad del jabón, masajear suavemente durante la limpieza, enjuagar muy bien con abundante agua y secar suavemente sin frotar.

PRECAUCIONES IMPORTANTES:
- Solo lavado externo. No introducir dentro de la vagina ni realizar duchas vaginales.
- Evitar el contacto con los ojos.
- Estos jabones no sustituyen tratamientos médicos. Ante síntomas como flujo anormal, mal olor persistente, ardor, dolor o picazón, orienta siempre a suspender el uso y consultar a un profesional de la salud (ginecólogo).

PRECIO: varía según farmacia, indica que consulten en la de su preferencia.
DÓNDE COMPRAR: en farmacias.

ESTILO:
- Amigable, cercano, profesional y respetuoso — como si fueras una persona real del equipo.
${ESTILO_BASE_CALIDEZ}
- ADAPTACIÓN DE LONGITUD: Analiza siempre lo que dice el cliente antes de responder. Si el cliente te manda un saludo simple (como "hola", "buenas", "hola qué tal"), una pregunta aislada muy breve o una interacción corta, responde de forma breve, natural y directa (1 o 2 oraciones máximo), sin soltar explicaciones largas ni presionar con información innecesaria. Si el cliente pregunta algo complejo, técnico o pide detalles del producto, entonces sí despliega una respuesta más completa (4-7 oraciones organizadas en párrafos cortos).
- Nunca repitas la misma frase textual de una conversación a otra para preguntas parecidas — reformula, varía el orden, varía las palabras, suena natural y espontáneo cada vez.
- Si la respuesta larga tiene varias ideas, organízalas en 2-3 párrafos cortos separados por saltos de línea. Nunca uses asteriscos, guiones de lista, numerales ni ningún símbolo de Markdown — en este chat se ven literalmente como símbolos sueltos, no como formato.
- Si la información está en este prompt, dila directo y con confianza, sin desviar hacia "consulta el empaque".
- No saludes con un saludo largo de bienvenida salvo que sea estrictamente necesario en el primer mensaje.
- Temas fuera de Dawrely/Danopac: redirige amablemente al producto.
- Si no sabes algo con certeza, no inventes: menciona que un asesor humano puede ayudar mejor.`;

// ─────────────────────────────────────────────────────────
// CONFIGURACIÓN DE CUENTAS
// ─────────────────────────────────────────────────────────
const ACCOUNTS = {
  '17841477353996766': {
    name: 'plopiee',
    token: process.env.INSTAGRAM_TOKEN,
    systemInstruction: SYSTEM_INSTRUCTION_PLOPIEE,
    marca: "P'Lopiee",
    pdfUrl: process.env.PLOPIEE_PDF_URL || null,
  },
  '17841457133320413': {
    name: 'dawsy',
    token: process.env.INSTAGRAM_TOKEN_DAWSY,
    systemInstruction: SYSTEM_INSTRUCTION_DAWSY,
    marca: 'Dawsy Quema Grasa',
    pdfUrl: process.env.DAWSY_PDF_URL || null,
  },
  '17841477670966653': {
    name: 'dawrely',
    token: process.env.INSTAGRAM_TOKEN_DAWRELY,
    systemInstruction: SYSTEM_INSTRUCTION_DAWRELY,
    marca: 'Dawrely',
    pdfUrl: process.env.DAWRELY_PDF_URL || null,
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

  if (pideHumano(userMessage)) {
    await escalarAHumano({ senderId, userMessage, wamid, conversationId, cuenta });
    return;
  }

  const esPreguntaDeUso = preguntaPorModoDeUso(userMessage);
  if (esPreguntaDeUso) {
    console.log(
      `[${cuenta.name}] Detectada pregunta de modo de uso. pdfUrl configurado: ${Boolean(cuenta.pdfUrl)}`
    );
  }
  if (cuenta.pdfUrl && esPreguntaDeUso) {
    await responderConPDF({ senderId, userMessage, wamid, conversationId, cuenta });
    return;
  }

  // ¿El cliente está confirmando que sí quiere la ficha que el bot ofreció
  // en un mensaje anterior? (ej. bot: "¿quieres que te la comparta?" / cliente: "sí")
  if (cuenta.pdfUrl && esConfirmacionCorta(userMessage)) {
    const ofrecioAntes = await elBotOfrecioLaFichaAntes(conversationId);
    if (ofrecioAntes) {
      console.log(`[${cuenta.name}] Confirmación de ficha detectada, enviando PDF.`);
      await responderConPDF({ senderId, userMessage, wamid, conversationId, cuenta });
      return;
    }
  }

  const instruccionCompleta = construirInstruccion(cuenta);
  const botResponse = await generarRespuestaGemini(userMessage, instruccionCompleta);
  await guardarYEnviar({ senderId, wamid, conversationId, cuenta, texto: botResponse });
}

function construirInstruccion(cuenta) {
  if (!cuenta.pdfUrl) return cuenta.systemInstruction;
  return cuenta.systemInstruction + INSTRUCCION_OFRECER_FICHA;
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

async function responderConPDF({ senderId, userMessage, wamid, conversationId, cuenta }) {
  const promptInterno = `${userMessage}

(Instrucción interna, no la repitas ni la menciones: el cliente está preguntando por el modo de uso. Respóndele con tus propias palabras, de forma natural, cálida y variada -nunca repitas la misma frase textual entre conversaciones distintas-, usando el detalle real que tienes en tus instrucciones (dosis, cómo tomarlo, recomendaciones). Cierra la respuesta mencionando de forma natural que le compartes la ficha técnica completa a continuación.)`;

  const texto = await generarRespuestaGemini(promptInterno, cuenta.systemInstruction);
  await guardarYEnviar({ senderId, wamid, conversationId, cuenta, texto });
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
        maxOutputTokens: 350,
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
          config: { systemInstruction, maxOutputTokens: 350 },
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

// Divide mensajes largos en varios envíos, porque Instagram trunca o
// rechaza mensajes de texto demasiado largos en una sola llamada.
async function enviarMensajeInstagram(recipientId, texto, token) {
  const url = `https://graph.instagram.com/v21.0/me/messages`;
  const MAX_LENGTH = 950;

  try {
    const fragmentos = [];
    let textoRestante = texto;

    while (textoRestante.length > 0) {
      if (textoRestante.length <= MAX_LENGTH) {
        fragmentos.push(textoRestante);
        break;
      }

      let corte = textoRestante.lastIndexOf('\n', MAX_LENGTH);
      if (corte === -1) corte = textoRestante.lastIndexOf(' ', MAX_LENGTH);
      if (corte === -1) corte = MAX_LENGTH;

      fragmentos.push(textoRestante.substring(0, corte).trim());
      textoRestante = textoRestante.substring(corte).trim();
    }

    for (const fragmento of fragmentos) {
      if (!fragmento) continue;

      await axios.post(
        url,
        { recipient: { id: recipientId }, message: { text: fragmento } },
        { params: { access_token: token } }
      );

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    console.error('Error Facebook (texto):', error.response?.data?.error?.message || error.message);
  }
}

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
    console.error(
      'Error Facebook (archivo):',
      JSON.stringify(error.response?.data?.error) || error.message
    );
  }
}

// 🔧 CORREGIDO: el dominio estaba mal escrito ("graph.imageUrl"), lo que
// hacía que esta llamada fallara SIEMPRE y devolviera el senderId (el
// número) en vez del nombre real del usuario en las notificaciones de
// WhatsApp cuando alguien pedía hablar con un humano.
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
    console.error('Error obteniendo nombre de usuario:', error.response?.data?.error?.message || error.message);
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
