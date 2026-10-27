// serverside/src/app.ts
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import compression from "compression";
import helmet from "helmet";
import { requestTiming, startEventLoopMonitor } from "./utils/perfLog";
import { LOGO_FILE } from "./config/emailLogo";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import config from "./config/config";
import { errorHandler } from "./middleware/errorHandler";
import { securityHeaders, additionalSecurityHeaders, sanitizeInput, apiLimiter } from "./middleware/security";
import { attachCsrfToken, csrfProtection } from "./middleware/csrf";

// Routes
import authRoutes from "./routes/auth";
import adminRoutes from "./routes/admin";
import auditLogsRoutes from "./routes/auditLogs";
import programsRoutes from "./routes/programs";
import unitsRoutes from "./routes/units";
import coordinatorRoutes from "./routes/coordinator";
import marksRoutes from "./routes/marks";
import institutionsRoutes from "./routes/institutions";
import studentsRoutes from "./routes/students";
import academicYearsRoutes from "./routes/academicYears";
import institutionSettingsRoutes from "./routes/institutionSettings";
import studentSearchRoutes from "./routes/studentSearch";
import programUnitsRouter from './routes/programUnits';
import promoteRoutes from "./routes/promote";
import maintenanceRoutes from "./routes/maintenance";
import billingRoutes from "./routes/billing";
import disciplinaryRoutes from "./routes/disciplinary";
import complianceRoutes from "./routes/compliance";

dotenv.config();

const app = express();
app.use(requestTiming);
startEventLoopMonitor();

// Public, cache-friendly logo for e-mails (no login, no cookies).
app.get("/brand/logo.png", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(LOGO_FILE, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// ── MUST be the very first app configuration ──────────────────────────────────
// Tells Express to trust the X-Forwarded-Proto header from Nginx.
// Without this:
//   - req.secure is false even on HTTPS
//   - res.cookie({ secure: true }) may not behave correctly
//   - Some security middleware may make wrong decisions
app.set("trust proxy", 1);
// ─────────────────────────────────────────────────────────────────────────────

app.use(compression());
app.use(securityHeaders); // configured helmet (CSP, HSTS, etc.)
app.use(additionalSecurityHeaders); // Permissions-Policy, Cache-Control, etc.
app.use(helmet());
app.disable("x-powered-by");

const allowedOrigins = [
  config.frontendUrl,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  // Add LAN IPs here for local dev — remove in production
  ...(process.env.NODE_ENV !== "production"
    ? [
        "http://192.168.1.10:3000",
        "http://10.105.149.124:3000",
        "http://192.168.17.124:3000",
      ]
    : []),
].filter(Boolean) as string[];



app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.error(`[CORS] Blocked: ${origin}`);
        callback(new Error("CORS Blocking: Unauthorized Origin"));
      }
    },

    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
    exposedHeaders: ["Content-Disposition"],
  }),
);

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '5mb', extended: true }));


app.use(cookieParser());
app.use(sanitizeInput);
app.use(attachCsrfToken);
// app.use(csrfProtection);

// app.use((req, res, next) => {
//   const uploadPaths = [
//     "/marks/upload",
//     "/students/bulk", // bulk student registration also uses multipart
//     "/students/template",
//   ];
//   const isUpload = uploadPaths.some((p) => req.path.startsWith(p));
//   if (isUpload) return next();
//   return csrfProtection(req, res, next);
// });

app.use((req, res, next) => {
  // Routes that must bypass CSRF:
  //   1. File uploads (multipart — token can't be sent in the body)
  //   2. SSE streaming endpoints — browser EventSource API cannot set custom headers,
  //      so the X-CSRF-Token header can never be sent by the client
  //   3. Public routes (no session, no token)
  const CSRF_BYPASS_PATHS = [
    // File uploads
    "/marks/upload",
    "/students/bulk",
    "/students/template",
    // SSE streaming report endpoints — EventSource cannot send headers
    "/promote/download-report-progress",
    "/promote/download-cms",
    "/promote/download-journey-cms",
    // Public endpoints
    "/institutions/public",
    "/auth/check-email",
    "/auth/verify-password",
    "/auth/verify-otp",
    "/admin/secret-register",
    "/admin/register",
    "/lead-capture",
    "/api/lead-capture",
  ];

  const isBypassed = CSRF_BYPASS_PATHS.some(p => req.path.startsWith(p));
  if (isBypassed) return next();
  return csrfProtection(req, res, next);
});

app.use(apiLimiter); // 120 req/min per IP globally

// Rate limiting (per IP)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests from this IP. Please try again later." },
});

app.use("/api/auth/", limiter);
app.use(
  "/api/marks/upload",
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 50,
    message: { message: "Upload limit reached. Try again in an hour." },
    standardHeaders: true,
    legacyHeaders: false,
  }),
); // 50 uploads/hour

// Health check - bypasses CORS
app.get("/health", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({ status: "OK", timestamp: new Date().toISOString(), uptime: process.uptime()});
});

// ── API router ───────────────────
const apiRouter = express.Router();

apiRouter.use("/auth", authRoutes);
apiRouter.use("/admin", adminRoutes);
apiRouter.use("/audit-logs", auditLogsRoutes);
apiRouter.use("/programs", programsRoutes);
apiRouter.use("/units", unitsRoutes);
apiRouter.use("/coordinator", coordinatorRoutes);
apiRouter.use("/marks", marksRoutes);
apiRouter.use("/institutions", institutionsRoutes);
apiRouter.use("/students", studentsRoutes);
apiRouter.use("/academic-years", academicYearsRoutes);
apiRouter.use("/institution-settings", institutionSettingsRoutes);
apiRouter.use("/student", studentSearchRoutes);
apiRouter.use("/program-units", programUnitsRouter);
apiRouter.use("/promote", promoteRoutes);
apiRouter.use("/maintenance", maintenanceRoutes);
apiRouter.use("/billing", billingRoutes);
apiRouter.use("/compliance", complianceRoutes);
apiRouter.use("/disciplinary", disciplinaryRoutes);

app.use("/api", apiRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.originalUrl} not found`, method: req.method });
});

// Global error handler
app.use(errorHandler);

export default app;
