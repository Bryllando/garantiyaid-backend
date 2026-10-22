# Staff assistant account history

Apply migrations and regenerate the Prisma client before starting the API:

```
npm run prisma:migrate:deploy
npm run prisma:generate
```

The staff assistant uses `/api/v1/chatbot/staff-assistant/conversations`. This is separate from the administrator's beneficiary-chat history. Every request requires an active staff session and is scoped to that user's current role and Barangay assignment. Responses are marked `no-store`.

- New messages and the unsent text draft are saved to the account. Only new messages are sent in batches of up to 20; existing messages are not truncated. Lists and transcripts are fetched in pages of 100.
- Explicitly opening, continuing or restoring a chat renews its 30-day inactivity period. Reading the history list, background hydration and archiving do not renew it. Archived chats follow the same expiry rule.
- Expired chats become inaccessible at the exact deadline. The API process deletes expired rows and their messages at startup and hourly thereafter. The timer stops during graceful shutdown.
- Archive is reversible. Delete removes the transcript and draft immediately; an empty tombstone remains until the original expiry to reject delayed create retries.
- Revision checks reject stale writes. Retrying a save with its mutation ID does not append duplicate messages. The UI preserves unsaved work and offers a separate copy on conflict.
- The browser's session store is a recovery cache, cleared on logout. Saved account history survives logout. Existing session-only conversations migrate on the next assistant opening. Operational previews, recipient lists and approval tokens are not persisted in chat history; unfinished workflows require preparation again.

Local verification (uses temporary test accounts, then removes them):

```powershell
$env:ASSISTANT_HISTORY_DB_TEST='1'
node --test test/assistantHistory.database.test.js
```

Frontend checks:

```
node --test test/assistant-history.test.js test/assistant-history-store.test.js
node scripts/verify-assistant-history.mjs
node scripts/verify-floating-assistant.mjs
```
