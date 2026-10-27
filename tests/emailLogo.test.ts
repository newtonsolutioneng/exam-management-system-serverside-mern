import test from "node:test";
import assert from "node:assert/strict";
import { getEmailLogo } from "../src/config/emailLogo";

test("EMAIL_LOGO_URL wins and nothing is attached", () => {
  const l = getEmailLogo({ emailLogoUrl: "https://cdn.example.com/logo.png", publicApiUrl: "https://api.example.com" });
  assert.equal(l.src, "https://cdn.example.com/logo.png"); assert.equal(l.attachments.length, 0);
});
test("PUBLIC_API_URL serves /brand/logo.png, no attachment", () => {
  const l = getEmailLogo({ publicApiUrl: "https://api.example.com/" });
  assert.equal(l.src, "https://api.example.com/brand/logo.png"); assert.equal(l.attachments.length, 0);
});
test("localhost / http / nothing falls back to inline cid (dev only)", () => {
  assert.equal(getEmailLogo({ publicApiUrl: "https://localhost:5000" }).src, "cid:applogo");
  assert.equal(getEmailLogo({ emailLogoUrl: "http://example.com/x.png" }).attachments.length, 1);
  assert.equal(getEmailLogo({}).attachments.length, 1);
});