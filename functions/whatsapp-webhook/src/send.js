const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "892409403959424";
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "EAAxE2T0i6wkBRhFF2oKgqX45DyI1owCdUXMVjfp7hnyWclhh5NfsWp9mspSCwFvdarLXf9DGGzlHH3U2tVriB8FPeRr7ZB9SPpsvfdMHXgX8XiNioOF5vqjp4mm4pvXnnR0Czdb5HSUvJdFTSrLT7ZCL3iB0yVCGmcuWXElo46KcvuXiF5VxIN56ZBezDO1DAZDZD";

export async function sendWhatsAppMessage(to, message) {

  const url = `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: {
      body: message
    }
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
    }

    return data;
  } catch (err) {
  }
}

export async function sendTemplate({
  to,
  templateName,
  languageCode = "en",
  bodyParams = [],
  buttonParams = []
}) {

  const components = [];

  // Body parameters ({{1}}, {{2}}, ...)
  if (bodyParams.length) {
    components.push({
      type: "body",
      parameters: bodyParams.map(text => ({
        type: "text",
        text: String(text)
      }))
    });
  }

  // Button parameters (for dynamic URL buttons etc.)
  if (buttonParams.length) {
    components.push(...buttonParams);
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components
    }
  };

  const res = await fetch(
    `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  const data = await res.json();

  if (!res.ok) {
    console.log(JSON.stringify(data));
  }

  return data;
}

export async function sendtyping(msgid) {

  const url = `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`;

  const payload = {
        "messaging_product": "whatsapp",
        "status": "read",
        "message_id": msgid,
        "typing_indicator": {
            "type": "text"
        }
    }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
    }

    return data;
  } catch (err) {
  }
}