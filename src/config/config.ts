// serverside/src/config/config.ts
import dotenv from "dotenv";

dotenv.config();

const config = Object.freeze({
  port: process.env.PORT || 3000,
  databaseURI: process.env.MONGODB_URI || "mongodb://localhost:2701",
  frontendUrl: process.env.FRONTEND_URL,
  /** public https URL of the logo used in e-mails (see config/emailLogo.ts) */
  emailLogoUrl: process.env.EMAIL_LOGO_URL,
  /** this server's public https address; /brand/logo.png is served from it */
  publicApiUrl: process.env.PUBLIC_API_URL,
  // jwtSecret: process.env.JWT_SECRET || "please-change-me",
  jwtSecret: process.env.JWT_SECRET!,
  emailHot: process.env.EMAIL_HOST,
  emailPot: process.env.EMAIL_PORT,
  emailUser: process.env.EMAIL_USER || "",
  emailPass: process.env.EMAIL_PASS || "",
  coodSec: process.env.COORDINATOR_SECRET || "",  
  appName: process.env.APP_NAME || "Exam System", 
  instName: process.env.INST_NAME || "My Institution",
  schoolName: process.env.SCHOOL_NAME || "My School",
  departmentName: process.env.DEPARTMENT_NAME || "My Department",
  registrar: process.env.REGISTRAR || "Registrar Office",
  postalAddress: process.env.POSTAL_ADDRESS || "Postal Address",
  cellPhone: process.env.CELL_PHONE || "Cell Phone",
  schoolEmail: process.env.SCHOOL_EMAIL || "School Email",
});

export default config;
