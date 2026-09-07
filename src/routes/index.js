import { Router } from "express";
import healthRoutes from "./health.routes.js";
import authRoutes from "../modules/auth/auth.routes.js";
import barangayRoutes from "../modules/barangays/barangay.routes.js";
import beneficiaryRoutes from "../modules/beneficiaries/beneficiary.routes.js";
import userRoutes from "../modules/users/user.routes.js";
import beneficiaryDocumentRoutes from "../modules/documents/beneficiaryDocument.routes.js";
import programRoutes from "../modules/programs/program.routes.js";
import enrollmentRoutes, { programEnrollmentRoutes } from "../modules/enrollments/enrollment.routes.js";
import auditLogRoutes from "../modules/audit/audit.routes.js";
import distributionRoutes from "../modules/distributions/distribution.routes.js";
import walletRoutes from "../modules/wallets/wallet.routes.js";
import dashboardRoutes from "../modules/dashboard/dashboard.routes.js";
import reportRoutes from "../modules/reports/report.routes.js";
import notificationRoutes, {
  distributionNotificationRoutes,
  scheduleNotificationRoutes,
} from "../modules/notifications/notification.routes.js";
import chatbotRoutes from "../modules/chatbot/chatbot.routes.js";
import staffNotificationRoutes from "../modules/staffNotifications/staffNotification.routes.js";

const apiRoutes = Router();

apiRoutes.use(healthRoutes);
apiRoutes.use("/auth", authRoutes);
apiRoutes.use("/barangays", barangayRoutes);
apiRoutes.use("/beneficiaries/:beneficiaryId/documents", beneficiaryDocumentRoutes);
apiRoutes.use("/beneficiaries", beneficiaryRoutes);
apiRoutes.use("/programs/:programId/enrollments", programEnrollmentRoutes);
apiRoutes.use("/programs", programRoutes);
apiRoutes.use("/enrollments", enrollmentRoutes);
apiRoutes.use("/users", userRoutes);
apiRoutes.use("/audit-logs", auditLogRoutes);
apiRoutes.use("/notifications", notificationRoutes);
apiRoutes.use("/staff-notifications", staffNotificationRoutes);
apiRoutes.use("/chatbot", chatbotRoutes);
apiRoutes.use("/distributions", distributionNotificationRoutes);
apiRoutes.use("/schedules", scheduleNotificationRoutes);
apiRoutes.use("/distributions", distributionRoutes);
apiRoutes.use("/wallets", walletRoutes);
apiRoutes.use("/dashboard", dashboardRoutes);
apiRoutes.use("/reports", reportRoutes);

export default apiRoutes;
