import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const PALABRAS_HUMANO = ['humano', 'agente', 'persona', 'asesor', 'operador', 'representante'];

const SYSTEM_INSTRUCTION = `Eres el asistente virtual oficial de P'Lopiee, un producto de la empresa Danopac, SRL.

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
Disponible en farmacias (menciona que pueden preguntar en su farmacia de confianza si no tienen una específica en mente).

TU ESTILO DE RESPUESTA:
- Responde de forma amigable, cercana y profesional, como si fueras parte del equipo de atención al cliente de Danopac.
- Sé breve y claro, evita respuestas muy largas.
- IMPORTANTE - FORMATO: escribe en texto plano, como un mensaje normal de WhatsApp o Instagram. NUNCA uses Markdown ni símbolos de formato como asteriscos (**), guiones para listas (-), numerales (#), guiones bajos (_) ni ningún otro símbolo de formato. Si necesitas enumerar algo, hazlo con palabras naturales (ej: "primero... segundo..." o simplemente en un párrafo corrido), nunca con listas con viñetas o símbolos.
- Si preguntan algo médico muy específico (dosis exactas, interacciones con medicamentos, contraindicaciones para embarazo, etc.), recomiéndales consultar con un médico o farmacéutico, no des consejos médicos como si fueras profesional de la salud.
- Si preguntan algo que no tiene nada que ver con P'Lopiee o Danopac, redirige la conversación amablemente hacia el producto.
- Si no sabes algo con certeza, no inventes información — menciona que un asesor humano puede ayudarles mejor con esa duda.`;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method === 'POST') {
    try {
      const { entry } = req.body;
      const entryItem = entry?.[0];

      const messagingEvent = entryItem?.messaging?.[0];
      const change = entryItem?.changes?.[0];

      let senderId, userMessage, wamid;

      if (messagingEvent?.message?.text) {
        senderId = messagingEvent.sender?.id;
        userMessage = messagingEvent.message.text;
        wamid = messagingEvent.message.mid;
      } else if (change?.field === 'messages' && change.value?.message?.text) {
        senderId = change.value.sender?.id;
        userMessage = change.value.message.text;
        wamid = change.value.message.mid;
      } else {
        return res.status(200).send('EVENT_RECEIVED');
      }

      if (!senderId || !userMessage || !wamid) {
        return res.status(200).send('EVENT_RECEIVED');
      }

      waitUntil(procesarMensaje({ senderId, userMessage, wamid }));

      return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
      console.error('ERROR DETALLADO:', error.stack);
      if (!res.headersSent) {
        return res.status(500).send('Error');
      }
    }
  }
}

async function procesarMensaje({ senderId, userMessage, wamid }) {
  try {
    let { data: conversation } = await supabase
      .from('conversations')
      .select('*')
      .eq('sender_id', senderId)
      .single();

    if (!conversation) {
      const { data: newConv } = await supabase
        .from('conversations')
        .insert({ sender_id: senderId })
        .select()
        .single();
      conversation = newConv;
    }

    const { error: insertError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        wa_message_id: wamid,
        role: 'user',
        content: userMessage,
      });

    if (insertError) {
      console.log('Mensaje duplicado, ignorado:', wamid);
      return;
    }

    if (conversation.is_human) {
      console.log('Conversación en modo humano, bot no responde:', senderId);
      return;
    }

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
      await notificarWhatsApp(senderId);
      return;
    }

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
  } catch (error) {
    console.error('Error procesando mensaje:', error);
  }
}

async function generarRespuestaGemini(mensajeUsuario) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: mensajeUsuario,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
      },
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

async function notificarWhatsApp(senderId) {
  const texto = encodeURIComponent(
    `🔔 Un usuario de Instagram (ID: ${senderId}) pidió hablar con un humano. Revisa el chat.`
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
