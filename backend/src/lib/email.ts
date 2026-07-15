import nodemailer from 'nodemailer';

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

const transporter = nodemailer.createTransport({
  host: process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com',
  port: Number(process.env.BREVO_SMTP_PORT || 587),
  secure: process.env.BREVO_SMTP_SECURE === 'true',
  auth: {
    user: process.env.BREVO_SMTP_LOGIN,
    pass: process.env.BREVO_SMTP_KEY,
  },
});

function getFromDetails() {
  const fromEmail = process.env.BREVO_FROM_EMAIL || process.env.BREVO_SMTP_LOGIN;
  const fromName = process.env.BREVO_FROM_NAME ?? 'FoodSood';
  return { fromEmail, fromName };
}

async function sendViaBrevoApi(to: string, otp: string): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not configured');
  }

  const { fromEmail, fromName } = getFromDetails();
  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: {
        email: fromEmail,
        name: fromName,
      },
      to: [{ email: to }],
      subject: `${otp} is your FoodSood verification code`,
      htmlContent: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:16px;border:1px solid #eee">
          <div style="font-size:28px;font-weight:900;letter-spacing:-1px;margin-bottom:8px">
            <span style="color:#1A2620">food</span><span style="color:#F4824A">sood</span>
          </div>
          <p style="font-size:15px;color:#444;margin:0 0 24px">Your verification code:</p>
          <div style="font-size:40px;font-weight:900;letter-spacing:10px;color:#1A2620;background:#F7F5F1;border-radius:12px;padding:20px 24px;text-align:center;margin-bottom:24px">
            ${otp}
          </div>
          <p style="font-size:13px;color:#888;margin:0">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
        </div>
      `,
      textContent: `Your FoodSood verification code is: ${otp}\n\nThis code expires in 10 minutes.`,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Brevo API failed: ${response.status} ${errorText}`);
  }
}

export async function sendOtpEmail(to: string, otp: string): Promise<void> {
  if (process.env.BREVO_API_KEY) {
    await sendViaBrevoApi(to, otp);
    return;
  }

  const { fromEmail, fromName } = getFromDetails();
  const from = `"${fromName}" <${fromEmail}>`;
  await transporter.sendMail({
    from,
    to,
    subject: `${otp} is your FoodSood verification code`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:16px;border:1px solid #eee">
        <div style="font-size:28px;font-weight:900;letter-spacing:-1px;margin-bottom:8px">
          <span style="color:#1A2620">food</span><span style="color:#F4824A">sood</span>
        </div>
        <p style="font-size:15px;color:#444;margin:0 0 24px">Your verification code:</p>
        <div style="font-size:40px;font-weight:900;letter-spacing:10px;color:#1A2620;background:#F7F5F1;border-radius:12px;padding:20px 24px;text-align:center;margin-bottom:24px">
          ${otp}
        </div>
        <p style="font-size:13px;color:#888;margin:0">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
      </div>
    `,
    text: `Your FoodSood verification code is: ${otp}\n\nThis code expires in 10 minutes.`,
  });
}
