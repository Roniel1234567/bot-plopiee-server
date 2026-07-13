import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import { Receiver } from '@upstash/qstash';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Validador de seguridad para asegurar que las peticiones vengan estrictamente de QStash
const qstashReceiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

const PALABRAS_HUMANO = ['humano', 'agente', 'persona', 'asesor', 'operador', 'representante'];

const SYSTEM_INSTRUCTION = `Eres el asistente virtual oficial de P'Lopiee, un producto de la empresa Danopac, SRL.

SOBRE EL PRODUCTO:
P'Lopiee es una crema mentolada con Castaño de Indias y extracto de Hamamelis, especializada para el cuidado de los pies y las piernas. Está formulada para aliviar molestias como cansancio, hinchazón, sensación de pesadez, tensión muscular y várices.

INGREDIENTES CLAVE Y BENEFICIOS:
- Extracto de Hamamelis Virginiana: astringente, antiinflamatorio y calmante. Reduce la inflamación, el enrojecimiento y la irritación, y tonifica y refresca la piel.
- Extracto de Castaño de Indias: vasoprotector y descongestivo. Favorece la microcirculación, fortalece las venas y reduce la sensación de pesadez, hinchazón y fatiga.
- Mentol: refrescante, calmante y descongestionante. Genera una sensación inmediata de frescor que alivia la incomodidad, el cansancio y la tensión muscular/cutánea, revitalizando la piel.

BENEFICIOS GENERALES:
- Alivia el cansancio y pesadez de piernas y pies.
- Ayuda con la sensación de várices y mala circulación.
- Antiinflamatorio y calmante para fatiga o tensión muscular.
- Efecto refrescante inmediato gracias al mentol.

PRECIO:
El precio puede variar según el punto de venta. Si te preguntan cuánto cuesta, indica amablemente que deben consultar el precio en su farmacia más cercana o de su confianza, ya que puede variar.

DÓNDE COMPRARLO:
Disponible en farmacias (menciona que pueden preguntar en su farmacia de confianza si no tienen una específica en mente).

TU ESTILO DE RESPUESTA:
- Responde de forma amigable, cercana y profesional, como si fueras parte del equipo de atención al cliente de Danopac.
- Sé breve y claro, evita respuestas muy largas.
- IMPORTANTE - SALUDOS: Responde directamente a lo que te preguntan de forma natural. NO saludes ni digas "Hola" en cada mensaje si el usuario ya te está haciendo una pregunta de seguimiento o si la conversación ya empezó, ya que resulta molesto y repetitivo. Saluda únicamente si el usuario solo te está diciendo hola o iniciando el chat por primera vez.
- IMPORTANTE - FORMATO: escribe en texto plano, como un mensaje normal de WhatsApp o Instagram. NUNCA uses Markdown ni símbolos de formato como asteriscos (**), guiones para listas (-), numerales (#), guiones bajos (_) ni ningún otro símbolo de formato. Si necesitas enumerar algo, hazlo con palabras naturales (ej: "primero... segundo..." o simplemente en un párrafo corrido), nunca con listas con viñetas o símbolos.
- Si preguntan algo médico muy específico (dosis exactas, interacciones con medicamentos, contraindicaciones para embarazo, etc.), recomiéndales consultar con un médico o farmacéutico, no des consejos médicos como si fueras profesional de la salud.
- Si preguntan algo que no tiene nada que ver con P'Lopiee o Danopac, redirige la conversación amablemente hacia el producto.
- Si no sabes algo con certeza, no inventes información — menciona que un asesor humano puede ayudarles mejor con esa duda.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    // 1. Validar firma de QStash para evitar peticiones maliciosas externas
    const signature = req.headers['upstash-signature'];
    const rawBody = JSON.stringify(req.body);
    
    const isValid = await qstashReceiver.verify({
      signature,
      body: rawBody,
    }).catch(() => false);

    if (!isValid) {
      console.error('Firma de QStash inválida.');
      return res.status(401).send('Unauthorized');
    }

    const { senderId, userMessage, wamid, conversationId } = req.body;

    // 2. Traer el estado más reciente de la conversación
    let { data: conversation } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', conversationId)
      .single();

    if (!conversation) {
      return res.status(200).send('Conversación no encontrada');
    }

    // 3. Comprobar expiración del modo humano (5 minutos)
    if (conversation.is_human) {
      const ahora = new Date();
      const ultimaActualizacion = new Date(conversation.updated_at);
      const diferenciaMinutos = (ahora - ultimaActualizacion) / (1000 * 60);

      if (diferenciaMinutos >= 5) {
        console.log('Modo humano expirado. Volviendo a modo IA:', senderId);
        await supabase
          .from('conversations')
          .update({ is_human: false, updated_at: ahora.toISOString() })
          .eq('id', conversation.id);
        conversation.is_human = false;
      } else {
        console.log('Modo humano activo. Bot omitido.');
        return res.status(200).send('MODO_HUMANO_ACTIVO');
      }
    }

    // 4. Evaluar si solicita atención humana
    const pideHumano = PALABRAS_HUMANO.some((palabra) =>
      userMessage.toLowerCase().includes(palabra)
    );

    if (pideHumano) {
      await supabase
        .from('conversations')
        .update({ is_human: true, updated_at: new Date().toISOString() })
        .eq('id', conversation.id);

      const mensajeConfirmacion = 'Listo, en un momento un asesor te atiende 🙌';

      await supabase.from('messages').insert({
        conversation_id: conversation.id,
        wa_message_id: `bot_${wamid}`,
        role: 'bot',
        content: mensajeConfirmacion,
      });

      await enviarMensajeInstagram(senderId, mensajeConfirmacion);
      await notificarWhatsApp(senderId, userMessage);
      return res.status(200).send('TRANSFERIDO_A_HUMANO');
    }

    // 5. Generar y enviar respuesta de Gemini
    const botResponse = await generarRespuestaGemini(userMessage);

    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      wa_message_id: `bot_${wamid}`,
      role: 'bot',
      content: botResponse,
    });

    await enviarMensajeInstagram(senderId, botResponse);

    await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversation.id);

    return res.status(200).send('PROCESADO_EXITOSAMENTE');
  } catch (error) {
    console.error('Error en el procesamiento de la cola:', error);
    return res.status(500).send('Error Interno');
  }
}

async function generarRespuestaGemini(mensajeUsuario) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: mensajeUsuario,
      config: { systemInstruction: SYSTEM_INSTRUCTION },
    });
    return response.text;
  } catch (error) {
    console.error('Error Gemini:', error.message);
    return 'Estamos teniendo mucha demanda ahorita, dame un momento y te respondo 🙏';
  }
}

async function enviarMensajeInstagram(recipientId, texto) {
  const url = `https://graph.instagram.com/v21.0/me/messages`;
  try {
    await axios.post(
      url,
      { recipient: { id: recipientId }, message: { text: texto } },
      { params: { access_token: process.env.INSTAGRAM_TOKEN } }
    );
  } catch (error) {
    console.error('Error Facebook:', error.response?.data?.error?.message);
  }
}

async function obtenerNombreUsuario(senderId) {
  try {
    const response = await axios.get(`https://graph.instagram.com/${senderId}`, {
      params: {
        fields: 'name,username',
        access_token: process.env.INSTAGRAM_TOKEN,
      },
    });
    return response.data.username || response.data.name || senderId;
  } catch (error) {
    console.error('Error obteniendo nombre de usuario:', error.response?.data?.error?.message);
    return senderId;
  }
}

async function notificarWhatsApp(senderId, mensajeUsuario) {
  const nombreUsuario = await obtenerNombreUsuario(senderId);
  const texto = encodeURIComponent(
    `🔔 P'Lopiee (Instagram)\n\nCliente: ${nombreUsuario}\nMensaje: "${mensajeUsuario}"\n\nPidió hablar con un asesor. Entra a Instagram para atenderlo.`
  );

  const notificaciones = [
    { phone: process.env.WHATSAPP_NOTIFY_1_PHONE, apikey: process.env.WHATSAPP_NOTIFY_1_APIKEY },
    { phone: process.env.WHATSAPP_NOTIFY_2_PHONE, apikey: process.env.WHATSAPP_NOTIFY_2_APIKEY },
  ];

  for (const n of notificaciones) {
    if (!n.phone || !n.apikey) continue;
    try {
      await axios.get(`https://api.callmebot.com/whatsapp.php?phone=${n.phone}&text=${texto}&apikey=${n.apikey}`);
    } catch (error) {
      console.error(`Error notificando a ${n.phone}:`, error.message);
    }
  }
}
