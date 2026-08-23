import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import {
  WALLET_MANAGE_ROLES,
  WALLET_READ_ROLES,
} from "../distributions/distribution.policy.js";
import {
  createSimulatedTransfer,
  createSimulatedWallet,
  getSimulatedWallet,
  getTransactionReceipt,
  listWalletTransactions,
  reverseBenefitCredit,
} from "./wallet.controller.js";
import {
  createWalletSchema,
  reverseBenefitCreditSchema,
  simulatedTransferSchema,
  walletParamsSchema,
  walletTransactionListQuerySchema,
  walletTransactionParamsSchema,
} from "./wallet.schemas.js";

const walletRoutes = Router();

walletRoutes.use(authenticateStaff);
walletRoutes.post(
  "/",
  authorizeRoles(...WALLET_MANAGE_ROLES),
  validateBody(createWalletSchema),
  createSimulatedWallet,
);
walletRoutes.get(
  "/:walletId",
  authorizeRoles(...WALLET_READ_ROLES),
  validateParams(walletParamsSchema),
  getSimulatedWallet,
);
walletRoutes.get(
  "/:walletId/transactions",
  authorizeRoles(...WALLET_READ_ROLES),
  validateParams(walletParamsSchema),
  validateQuery(walletTransactionListQuerySchema),
  listWalletTransactions,
);
walletRoutes.post(
  "/:walletId/transfers",
  authorizeRoles(...WALLET_MANAGE_ROLES),
  validateParams(walletParamsSchema),
  validateBody(simulatedTransferSchema),
  createSimulatedTransfer,
);
walletRoutes.get(
  "/:walletId/transactions/:transactionId/receipt",
  authorizeRoles(...WALLET_READ_ROLES),
  validateParams(walletTransactionParamsSchema),
  getTransactionReceipt,
);
walletRoutes.post(
  "/:walletId/transactions/:transactionId/reverse",
  authorizeRoles(...WALLET_MANAGE_ROLES),
  validateParams(walletTransactionParamsSchema),
  validateBody(reverseBenefitCreditSchema),
  reverseBenefitCredit,
);

export default walletRoutes;
