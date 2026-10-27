// // serverside/src/services/twoFactorService.ts
// import nodemailer from "nodemailer";
// import config from "../config/config";

// const getTransporter = () =>
//   nodemailer.createTransport({
//     host: config.emailHot || "smtp.gmail.com",
//     port: Number(config.emailPot) || 587,
//     secure: false,
//     auth: {user: config.emailUser, pass: config.emailPass},
//   });

// export const sendOTPEmail = async (
//   email: string,
//   name: string,
//   otp: string,
//   purpose: "login" | "register",
// ): Promise<void> => {
//   const transporter = getTransporter();

//   const subject =
//     purpose === "login" ? "Your login verification code" : "Verify your registration";

//   const fromName = config.appName || "EMS Academic System";

//   await transporter.sendMail({
//     from: `"${fromName}" <${config.emailUser}>`,
//     to: email,
//     subject,
//     html: `
// <!DOCTYPE html>
// <html>
// <head>
//   <meta charset="utf-8">
//   <meta name="viewport" content="width=device-width,initial-scale=1">
// </head>
// <body style="margin:0;padding:0;background:#f5f4f0;font-family:'Georgia',serif;">
//   <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
//     <tr>
//       <td align="center">
//         <table width="480" cellpadding="0" cellspacing="0"
//                style="background:#1a3a2a;border-radius:16px;overflow:hidden;">
//           <!-- Header -->
//           <tr>
//             <td style="padding:36px 40px 24px;text-align:center;">
//               <div style="display:inline-block;width:48px;height:48px;background:#c9a227;
//                           border-radius:12px;line-height:48px;font-size:24px;">
                
//               </div>
//               <h1 style="color:#c9a227;font-size:13px;letter-spacing:4px;
//                          text-transform:uppercase;margin:16px 0 0;font-weight:400;">
//                 ${purpose === "login" ? "Login Verification" : "Registration Verification"}
//               </h1>
//             </td>
//           </tr>
//           <!-- Body -->
//           <tr>
//             <td style="padding:0 40px 36px;">
//               <p style="color:#a8c4b0;font-size:15px;line-height:1.6;margin:0 0 24px;">
//                 Hi ${name},
//               </p>
//               <p style="color:#a8c4b0;font-size:15px;line-height:1.6;margin:0 0 32px;">
//                 ${
//                   purpose === "login"
//                     ? "Enter the code below to complete your login. It expires in <strong style='color:#c9a227'>10 minutes</strong>."
//                     : "Enter the code below to verify your registration. It expires in <strong style='color:#c9a227'>10 minutes</strong>."
//                 }
//               </p>
//               <!-- OTP Code Box -->
//               <div style="background:#0d2218;border-radius:12px;padding:32px;
//                           text-align:center;margin-bottom:32px;">
//                 <div style="font-family:'Courier New',monospace;font-size:48px;
//                             font-weight:700;letter-spacing:16px;color:#c9a227;
//                             text-shadow:0 0 30px rgba(201,162,39,0.3);">
//                   ${otp}
//                 </div>
//               </div>
//               <p style="color:#5a7a65;font-size:13px;line-height:1.6;margin:0;">
//                 If you did not request this, you can safely ignore this email.
//                 Your account remains secure.
//               </p>
//             </td>
//           </tr>
//           <!-- Footer -->
//           <tr>
//             <td style="padding:20px 40px;border-top:1px solid #2a4a3a;
//                        text-align:center;">
//               <p style="color:#3a5a4a;font-size:11px;letter-spacing:2px;
//                         text-transform:uppercase;margin:0;">
//                 Exams Management System · Secured
//               </p>
//             </td>
//           </tr>
//         </table>
//       </td>
//     </tr>
//   </table>
// </body>
// </html>
//     `,
//   });
// };






// serverside/src/services/twoFactorService.ts
import nodemailer from "nodemailer";
import config from "../config/config";
import { getEmailLogo } from "../config/emailLogo";

const getTransporter = () =>
  nodemailer.createTransport({
    host: config.emailHot || "smtp.gmail.com",
    port: Number(config.emailPot) || 587,
    secure: false,
    auth: { user: config.emailUser, pass: config.emailPass },
  });

// Path to your logo

export const sendOTPEmail = async (
  email: string,
  name: string,
  otp: string,
  purpose: "login" | "register",
): Promise<void> => {
  const transporter = getTransporter();

  const subject =
    purpose === "login" ? "Your login verification code" : "Verify your registration";

  const fromName = config.appName || "EMS Academic System";
  const roleLabel = purpose === "login" ? "Login Verification" : "Registration Verification";

  await transporter.sendMail({
    from: `"${fromName}" <${config.emailUser}>`,
    to: email,
    subject,
    // The logo is referenced by URL; it is attached inline only in local development.
    attachments: getEmailLogo().attachments,
    html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',
             Roboto,Helvetica,Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr>
      <td align="center">

        <table width="500" cellpadding="0" cellspacing="0"
                style="background:#ffffff;border-radius:8px;
                       border:1px solid #e5e7eb;overflow:hidden;">

          <tr>
            <td style="padding:20px 32px;border-bottom:1px solid #e5e7eb;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:15px;font-weight:700;color:#111827;">
                    ${fromName}
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
                        border-radius:999px;background:#f0fdf4;border:1px solid #bbf7d0;
                        font-size:12px;font-weight:600;color:#15803d;
                        letter-spacing:0.04em;text-transform:uppercase;">
                ${roleLabel}
              </p>

              <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;
                         color:#111827;line-height:1.3;">
                Verification Code
              </h1>

              <p style="margin:0 0 28px;font-size:14px;color:#6b7280;line-height:1.6;">
                Hello <strong style="color:#111827;">${name}</strong>,<br />
                Enter the code below to complete your ${purpose}. 
                This code expires in <strong style="color:#111827;">10 minutes</strong>.
              </p>

              <div style="background:#f9fafb;border-radius:12px;padding:32px;
                          text-align:center;margin-bottom:28px;border:1px solid #e5e7eb;">
                <div style="font-family:'Courier New',monospace;font-size:42px;
                            font-weight:700;letter-spacing:12px;color:#1d4ed8;">
                  ${otp}
                </div>
              </div>

              <p style="margin:0;font-size:13px;color:#9ca3af;line-height:1.6;text-align:center;">
                If you did not request this, you can safely ignore this email.
                Your account remains secure.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 32px; border-top:1px solid #e5e7eb;">
               <p style="margin:0;font-size:11px;color:#d1d5db;text-align:center;text-transform:uppercase;letter-spacing:1px;">
                ${fromName} · Secured Verification
              </p>
            </td>
          </tr>
        </table>

        <p style="margin:20px 0 0;font-size:11px;color:#9ca3af;text-align:center;">
          Authorized use only · Audit log active
        </p>

      </td>
    </tr>
  </table>
</body>
</html>
    `,
  });
};