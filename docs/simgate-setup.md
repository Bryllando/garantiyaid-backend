# SimGate setup for GarantiyAid

Use one dedicated Android phone as the sending gateway. Beneficiaries receive an ordinary SMS; they do not install SimGate. Staff-account emails continue to use the separately configured email provider.

## 1. Prepare the phone

1. Put an active Philippine SIM in an Android phone. Make sure a normal text sent from Messages reaches your own test number. Have load or an applicable SMS promo.
2. Keep the phone connected to Wi-Fi or mobile data, with cellular signal and sufficient battery.
3. Create/sign into your account at https://www.simgate.app/ and stay on the Free plan for the demo.
4. On the dashboard, choose **Download app** and follow its official Google Play link. Do not disable Play Protect to get past an unexplained warning; check the exact warning first.

## 2. Connect the phone

1. Dashboard → **Register Mobile Device → Generate QR Code**.
2. On the phone, open SimGate → **Scan QR Token**. Alternatively, use **Copy Token** on the dashboard and **Enter token manually** on the phone. This pairing QR is unrelated to beneficiary claim QR cards.
3. Complete the app's readiness checks: **SIM routing**, **SMS permission**, and **background reliability**. Select the intended sending SIM if the phone has two. Use the app's Battery Settings shortcut to allow its required background operation.
4. Wait until the dashboard shows **Online**. Copy the **Device ID** displayed under the phone.

## 3. Prove the gateway works first

Use **Try it now** on the SimGate dashboard. Choose the connected phone, enter your own test number in international format (for example, `0917…` becomes `+63917…`), and send one short test message. Confirm the text arrived on the receiving phone before continuing. This uses your quota and SIM allowance.

Dashboard → **API keys → Generate API key**. Keep the key private; do not paste it into chat, screenshots, Git, or the frontend.

Official walkthrough: https://www.simgate.app/getting-started

## 4. Configure the GarantiyAid backend

In `garantiyaid-backend/.env`, replace the existing SMS mode and add these values (do not create duplicate variable entries):

```dotenv
SMS_PROVIDER_MODE=SIMGATE
SIMGATE_API_KEY=your_private_api_key
SIMGATE_DEVICE_ID=your_paired_device_id
SMS_REQUEST_TIMEOUT_MS=15000
```

Keep these in the backend only. Do not use `VITE_` variables for the API key. No new packages or database migration are needed. Leave the existing email and Redis configuration intact.

Stop the existing API and notification worker with Ctrl+C, then restart them in separate terminals from the backend folder:

```powershell
# Terminal 1
cd C:\Users\Lenovo\Desktop\GARANTIYAID\garantiyaid-backend
npm start
```

```powershell
# Terminal 2
cd C:\Users\Lenovo\Desktop\GARANTIYAID\garantiyaid-backend
npm run worker:notifications
```

Keep Redis, both terminals, the frontend, and the gateway phone running. Do not start a second API on port 4000. The notification worker also processes pending staff emails. Jobs recorded under the old SIMULATED mode stay simulated; enabling SimGate does not convert them into real texts.

## 5. Send one notice from GarantiyAid

1. Use your own test beneficiary with a valid mobile number that you control. Keep the usual approved enrollment, allocation and schedule requirements; importing a phone number alone does not create a schedule.
2. Sign in as authorized staff. Open **SMS delivery** (or **SMS notifications and delivery monitoring**, depending on role), at `/notifications`.
3. Confirm the banner shows **SimGate SMS** and that there is no **Worker offline** notice. If it still says simulation, restart both API and worker after checking `.env`.
4. Click **Queue schedule message**. Select the test event and its scheduled beneficiary; search by name/queue number if needed.
5. Choose the appropriate message purpose → **Preview message**. Check the masked receiving number, event, time and wording.
6. Click **Confirm and queue** once. For the first demo, use this single-beneficiary action instead of **Queue reminders**, which covers a whole event.
7. Follow the record: **Queued → Gateway accepted**, or a failure with its error code. Open **View details** for the provider reference and attempt count. Verify actual arrival on the recipient phone.

The API calls `POST https://api.simgate.app/v1/sms/send` with `x-api-key` and `{ deviceId, phoneNumber, message }`. Both an online-device acceptance (200) and SimGate's offline queue acceptance (202) are saved as `SENT` in the existing database, but shown as **Gateway accepted** in the UI. This does not assert handset delivery. SimGate can retain an offline message and dispatch it when the phone reconnects; do not submit it again just because it has not arrived yet.

## Local SMS demo already prepared

The local **TEST SMS Notification Demo** event now has two synthetic beneficiaries, **SMS Demo Alpha** (number ending **3150**) and **SMS Demo Beta** (ending **9876**), allocated and scheduled for **December 11, 2026, 08:50 PHT**. The event's original date, time and venue were preserved. It remains a draft; reminders can be queued for a draft with active schedules, so opening a distribution or generating QR credentials is unnecessary for this SMS test.

The preparation uses a separate **TEST ONLY - SMS notification demo** program. It does not approve either person for the existing Community Cash Assistance program. Its PHP 1 grant / PHP 2 budget are synthetic fixture values; no payment, claim, release, QR credential, mobile account or SMS was created. A disabled fixture owner and a SYSTEM audit record identify the preparation; no real staff reviewer is recorded as having approved these demo identities.

To reproduce this exact preparation on the local development database only:

```powershell
node scripts/prepare-local-sms-demo.js --apply --distribution-id=5504d5e4-34f0-4fa8-b91e-a9f80ad8c336
```

The script refuses production/remote databases, real beneficiary records, or an event with existing work. A repeat run checks the same recipients without duplicating the fixtures or sending messages.

To test from **Staff Assistant → Prepare a reminder**:

1. Choose **TEST SMS Notification Demo**, **All scheduled service areas**, and **Queue now**. The SMS is sent after confirmation now; the December appointment date does not delay a "Queue now" reminder.
2. Use: `TEST ONLY - GarantiyAid SMS demo for {beneficiary}. This is a test message, not a real aid schedule or claim authorization.`
3. Match the records and preview. An old preview showing 0 recipients must be rechecked or recreated. Expect **2 recipients, 0 excluded**, the two masked numbers, and **Real SMS via SimGate**.
4. If it still says simulated, restart the existing API and notification worker terminals with the configured `.env`, then obtain a new preview. Do not confirm a simulation expecting a real text.
5. Keep the SimGate phone online with SMS permission, signal and a usable SIM text allowance. Review the two test recipients, check the acknowledgment and click **Confirm and queue 2 reminders** once.
6. Open **SMS delivery** and check **Gateway accepted**, then confirm receipt on each receiving phone. Gateway acceptance alone is not proof of handset delivery.

When no recipients match, the assistant now explains the schedule requirement and provides **Review event setup** / **Review queue and schedules** and **Recheck recipients**. Rechecking invalidates the previous acknowledgment, so changed recipients must be reviewed again.

If a demo appointment was cancelled, **Schedule remaining** will not recreate it. In the event's **Schedule** step, click **Review cancelled schedules**, find the beneficiary, then **Reactivate → Reactivate schedule**. This restores the same appointment after capacity and allocation checks. Return to the assistant and recheck recipients. Leaving Alpha cancelled includes only Beta in this demo reminder; the event does not need to be opened to test SMS.

## Limits and troubleshooting

The Free plan currently advertises **10 SMS/day, 250 SMS/month, 1 device**. Sending ten texts to the same number also uses ten sends. Carrier charges and multipart SMS costs depend on your SIM plan and message encoding; keep demo notices short. Check actual remaining usage in SimGate rather than assuming a Philippine-midnight reset. Pricing: https://www.simgate.app/pricing

| What you see | What to check |
| --- | --- |
| Still **Simulation** | API and worker must both restart with `SMS_PROVIDER_MODE=SIMGATE`. Old records retain their original mode. |
| **Worker offline** / stuck **Queued** | Start `npm run worker:notifications` and check Redis. API running alone does not send messages. |
| **Not sent (old worker)** | The previous worker used the local simulator for a live request. Restart that worker with the updated code; its ready line must include `SMS: SIMGATE`. After the affected record has been checked and reconciled, retry that existing notification once. Refreshing the API alone does not reload a separate worker. |
| `SIMGATE_SEND_401` | API key is missing, revoked, or wrong. Generate/copy a valid key privately. |
| `SIMGATE_SEND_403` | Check the dashboard for quota/account restrictions. The official guide lists quota exceeded as 403. |
| `SIMGATE_SEND_404` | Device ID must belong to the same account as the API key. |
| `SIMGATE_SEND_429` | Provider rate limit; wait and inspect dashboard usage before retrying. |
| `INVALID_RECIPIENT` / `MISSING_RECIPIENT` | Update the beneficiary contact to `09` plus nine digits or `+639` plus nine digits. |
| **Gateway accepted**, no text yet | Check phone Online state, SMS permission, selected SIM, load/promo, carrier signal, and the receiving phone. An accepted offline command may still be queued by SimGate. |
| **Check gateway** / `SIMGATE_DELIVERY_UNCONFIRMED` | A timeout, invalid response, or interrupted worker leaves the outcome uncertain. Check SimGate and the receiving phone. Automatic/manual retry is blocked to prevent duplicate texts; reconcile before preparing any new notice. |

SimGate does not provide a documented request idempotency guarantee in the setup guide. GarantiyAid therefore records a send-start marker before a real external request and does not automatically repeat an uncertain submission. Delivery receipts, inbound replies, and webhook synchronization are not implemented in this integration.

To return to the demo simulator, set `SMS_PROVIDER_MODE=SIMULATED` and restart both processes. New records will be simulated. Existing unprocessed SimGate records fail closed while live sending is disabled; already accepted commands may still be held by SimGate, so switching modes does not cancel them there.
