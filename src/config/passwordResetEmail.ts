
// serverside/src/config/passwordResetEmail.ts
import nodemailer from "nodemailer";
import config from "./config";
import { getEmailLogo } from "./emailLogo";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: config.emailUser,
    pass: config.emailPass,
  },
});

// Path to your logo

export const sendRecoveryEmail = async (
  to: string,
  token: string,
  name: string,
) => {
  const link = `${config.frontendUrl}/reset-password/${token}`;

  await transporter.sendMail({
    from: `"${config.appName} Security" <${config.emailUser}>`,
    to,
    subject: `Password Recovery — ${config.appName}`,
    // The logo is referenced by URL; it is attached inline only in local development.
    attachments: getEmailLogo().attachments,
    html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Password Recovery</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',
             Roboto,Helvetica,Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr>
      <td align="center">

        <table width="560" cellpadding="0" cellspacing="0"
                style="background:#ffffff;border-radius:8px;
                       border:1px solid #e5e7eb;overflow:hidden;">

          <tr>
            <td style="padding:20px 32px;border-bottom:1px solid #e5e7eb;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:15px;font-weight:700;color:#111827;">
                    ${config.appName}
                  </td>
                  <td align="right">
                  <img src="${getEmailLogo().src}" alt="Logo" width="36" height="36" 
                         style="display:block;border-radius:6px;object-fit:contain;" />
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:36px 32px 28px;">

              <p style="margin:0 0 20px;display:inline-block;padding:4px 12px;
                        border-radius:999px;background:#fef2f2;border:1px solid #fecaca;
                        font-size:12px;font-weight:600;color:#991b1b;
                        letter-spacing:0.04em;text-transform:uppercase;">
                Identity Recovery
              </p>

              <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;
                         color:#111827;line-height:1.3;">
                Reset Your Password
              </h1>

              <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
                Hello <strong style="color:#111827;">${name}</strong>,<br />
                A request has been initiated to reset the security key for your account at 
                <strong style="color:#111827;">${config.instName}</strong>.
              </p>

              <p style="margin:0 0 28px;font-size:14px;color:#6b7280;line-height:1.6;">
                To establish a new connection and update your credentials, please use the secure link below.
                This link is single-use and expires in <strong style="color:#111827;">60 minutes</strong>.
              </p>

              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr>
                  <td align="center">
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="border-radius:6px;background:#1d4ed8;">
                          <a href="${link}"
                             style="display:inline-block;padding:13px 28px;
                                    font-size:14px;font-weight:600;color:#ffffff;
                                    text-decoration:none;letter-spacing:0.02em;">
                            Update Security Key →
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:13px;color:#9ca3af;line-height:1.6;text-align:center;">
                If you did not request this, please contact your administrator immediately.
                No changes have been made to your account.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 32px; border-top:1px solid #e5e7eb; background:#f9fafb;">
               <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
                Protected by ${config.appName} Infrastructure · Audit log active
              </p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>
    `,
  });
};
