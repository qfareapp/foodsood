import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_LOGIN,
    pass: process.env.BREVO_SMTP_KEY,
  },
});

export async function sendOtpEmail(to: string, otp: string): Promise<void> {
  const from = `"${process.env.BREVO_FROM_NAME ?? 'FoodSood'}" <${process.env.BREVO_SMTP_LOGIN}>`;
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
