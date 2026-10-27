// serverside/src/config/email.ts
import nodemailer from "nodemailer";
import config from "./config";
import path from "path";
import { getEmailLogo } from "./emailLogo";

// ─── Email transporter ─────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: config.emailUser, pass: config.emailPass },
});

// ─── Types ────────────────────────────────────────────────────────────────────
export interface InviteEmailContext {
  to:               string;
  token:            string;
  name:             string;
  role:             "coordinator" | "lecturer";
  universityName:   string;
  schoolName?:      string;
  departmentName?:  string;
  institutionWide?: boolean;
}

// Path to your logo - using process.cwd() to reach the root public folder

// ─── Helper — logo HTML ──────────────────────────────────────────────────────
function logoImg(width: number = 44, height: number = 44): string {
  // Public URL when configured (no attachment); inline cid only as the local-development fallback.
  return `<img src="${getEmailLogo().src}" alt="${config.appName}" width="${width}" height="${height}" 
               style="display:block;border-radius:6px;object-fit:contain;" />`;
}

// ─── Helper — detail table row ────────────────────────────────────────────────
function detailRow(label: string, value: string): string {
  return `
  <tr>
    <td style="padding:8px 0;font-size:13px;color:#6b7280;white-space:nowrap;padding-right:24px;">${label}</td>
    <td style="padding:8px 0;font-size:13px;color:#111827;font-weight:500;">${value}</td>
  </tr>`;
}

// ─── Helper — build assignment rows based on role and scope ───────────────────
function buildAssignmentRows(ctx: InviteEmailContext): string {
  if (ctx.role === "lecturer") {
    const rows: string[] = [];
    if (ctx.schoolName) rows.push(detailRow("School", ctx.schoolName));
    if (ctx.departmentName) rows.push(detailRow("Department", ctx.departmentName));
    return rows.join("");
  }

  if (ctx.institutionWide) {
    return detailRow("Access Level", "Institution-wide");
  }

  const rows: string[] = [];
  if (ctx.schoolName) rows.push(detailRow("School", ctx.schoolName));
  if (ctx.departmentName) rows.push(detailRow("Department", ctx.departmentName));
  return rows.join("");
}

// ─── Helper — coordinator secret note ────────────────────────────────────────
function buildCoordSecNote(ctx: InviteEmailContext): string {
  if (ctx.role !== "coordinator" || !config.coodSec) return "";

  return `
    <div style="margin:24px 0;padding:14px 18px;border-radius:6px;
                background:#fffbeb;border:1px solid #fde68a;">
      <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#92400e;
                text-transform:uppercase;letter-spacing:0.05em;">
        Coordinator Access Code
      </p>
      <p style="margin:0;font-size:13px;color:#78350f;line-height:1.5;">
        Your coordinator secret is required during account setup.
        Keep this confidential.
      </p>
      <p style="margin:8px 0 0;text-align:center;font-family:'Courier New',monospace;font-size:15px;
                font-weight:700;color:#92400e;letter-spacing:2px;">
        ${config.coodSec}
      </p>
    </div>`;
}

// ─── Main email sender ────────────────────────────────────────────────────────
export const sendInviteEmail = async (ctx: InviteEmailContext): Promise<void> => {
  const link = `${config.frontendUrl}/register/${ctx.token}`;
  const roleLabel = ctx.role === "coordinator" ? "Exam Coordinator" : "Lecturer";
  const expiry = ctx.role === "coordinator" ? "7 days" : "24 hours";

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Invitation — ${config.appName}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',
             Roboto,Helvetica,Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr>
      <td align="center">

        <table width="600" cellpadding="0" cellspacing="0"
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
                    ${logoImg(36, 36)}
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

              

              <p style="margin:0 0 28px;font-size:14px;color:#6b7280;">
                Hello <strong style="color:#111827;">${ctx.name}</strong>,
              </p>
              <p style="margin:0 0 28px;font-size:14px;color:#6b7280;">
                You have been added to <strong style="color:#111827;">${ctx.universityName}</strong>
                on <strong style="color:#111827;">${config.appName}</strong>.
              </p>

              <div style="background:#f9fafb;border-radius:6px;
                          border:1px solid #e5e7eb;padding:18px 22px;
                          margin-bottom:28px;">
                <p style="margin:0 0 12px;font-size:11px;font-weight:600;
                          color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em;">
                  Assignment Details
                </p>
                <table cellpadding="0" cellspacing="0">
                  ${detailRow("University", ctx.universityName)}
                  ${detailRow("Role", roleLabel)}
                  ${buildAssignmentRows(ctx)}
                </table>
              </div>

              

              <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
                <tr>
                  <td style="border-radius:6px;background:#1d4ed8;">
                  <a href="${link}"
                                style="display: inline-block; padding: 12px 28px; background: #1a3a1a;
                                         color: #cfba29; text-decoration: none; border-radius: 6px;
                                         font-weight: 700; font-size: 14px; letter-spacing: 0.03em;">
                                 Accept Invitation &amp; Set Password
                              </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 8px;font-size:13px;color:#6b7280;line-height:1.6;text-align:center;">
                This invitation expires in <strong style="color:#374151;">${expiry}</strong>.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 32px; border-top:1px solid #e5e7eb;">
               <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
                Sent by ${config.appName} · Authorized use only · Audit log active
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  await transporter.sendMail({
    from: `"${config.appName}" <${config.emailUser}>`,
    to: ctx.to,
    subject: `Invitation — to join ${ctx.universityName} on ${config.appName}`,
    html,
    // Empty when the logo is referenced by URL — nothing is attached to the message.
    attachments: getEmailLogo().attachments
  });
};









