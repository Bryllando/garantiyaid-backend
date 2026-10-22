import { Router } from "express";
import { z } from "zod";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { actOnAssistantConversation, getAssistantConversation, listAssistantConversations, saveAssistantConversation } from "./assistantHistory.service.js";

export const conversationSaveSchema = z.object({
  revision: z.number().int().nonnegative(), mutationId: z.uuid(),
  language: z.enum(["en", "fil", "ceb"]), input: z.string().max(300), unfinished: z.boolean(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(10000), local: z.boolean().default(false) }).strict()).max(20),
}).strict();
const idSchema = z.object({ id: z.uuid() });
const pageSchema = z.object({ offset: z.coerce.number().int().min(0).max(10000000).default(0) });
const actionSchema = z.object({ action: z.enum(["touch", "archive", "restore", "delete"]), revision: z.number().int().nonnegative() }).strict();
const router = Router();
router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
const respond = (fn) => asyncHandler(async (req, res) => res.json({ success: true, data: await fn(req) }));
router.get("/", validateQuery(pageSchema), respond(req => listAssistantConversations(req.staffUser, req.validatedQuery)));
router.get("/:id", validateParams(idSchema), validateQuery(pageSchema), respond(req => getAssistantConversation(req.staffUser, req.validatedParams.id, req.validatedQuery)));
router.post("/:id", validateParams(idSchema), validateBody(conversationSaveSchema), respond(req => saveAssistantConversation(req.staffUser, req.validatedParams.id, req.validatedBody, true)));
router.patch("/:id", validateParams(idSchema), validateBody(conversationSaveSchema), respond(req => saveAssistantConversation(req.staffUser, req.validatedParams.id, req.validatedBody)));
router.post("/:id/actions", validateParams(idSchema), validateBody(actionSchema), respond(req => actOnAssistantConversation(req.staffUser, req.validatedParams.id, req.validatedBody)));
export default router;
