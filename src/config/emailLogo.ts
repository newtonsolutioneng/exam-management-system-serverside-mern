// serverside/src/config/emailLogo.ts
//
// The logo in every e-mail. It is referenced by a public https URL so it shows in the message
// itself and does NOT arrive as a separate attachment.
//
// Resolution order:
//   1. EMAIL_LOGO_URL            — any public https image URL (recommended)
//   2. PUBLIC_API_URL            — this server's public https address; the logo is served from /brand/logo.png
//   3. otherwise (local development, no public address) the logo is embedded inline as before,
//      because an e-mail cannot reach localhost.

import path from "path";
import config from "./config";

export const LOGO_FILE = path.join(process.cwd(), "public", "acadedesk.png");

const isPublicHttps = (u?: string): u is string => {
  if (!u || !/^https:\/\//i.test(u)) return false;
  try {
    const h = new URL(u).hostname;
    return h !== "localhost" && h !== "127.0.0.1";
  } catch {
    return false;
  }
};

export interface EmailLogo {
  src: string;
  attachments: Array<{ filename: string; path: string; cid: string }>;
}

export function getEmailLogo(
  opts: { emailLogoUrl?: string; publicApiUrl?: string } = {
    emailLogoUrl: config.emailLogoUrl,
    publicApiUrl: config.publicApiUrl,
  },
): EmailLogo {
  const { emailLogoUrl, publicApiUrl } = opts;
  if (isPublicHttps(emailLogoUrl))
    return { src: emailLogoUrl, attachments: [] };
  if (isPublicHttps(publicApiUrl))
    return {
      src: `${publicApiUrl.replace(/\/+$/, "")}/brand/logo.png`,
      attachments: [],
    };
  return {
    src: "cid:applogo",
    attachments: [{ filename: "logo.png", path: LOGO_FILE, cid: "applogo" }],
  };
}