from pathlib import Path
from datetime import date
import re

root = Path(__file__).resolve().parents[1]
schema = (root / 'prisma/schema.prisma').read_text(encoding='utf-8')
models = re.findall(r'^model (\w+) \{(.*?)^\}', schema, re.M | re.S)
names = {name for name, _ in models}
purposes = {
    'User': 'Staff identity, role, assignment, and authentication state.',
    'StaffSession': 'Revocable staff sign-in session.',
    'StaffPasswordResetToken': 'Single-use hashed staff password-reset token.',
    'StaffRecoveryCode': 'Hashed second-factor recovery code.',
    'IdempotencyRecord': 'Request replay protection for sensitive mutations.',
    'Barangay': 'Service area and facilitator scope.',
    'Program': 'Assistance program, amount, budget, and lifecycle.',
    'ProgramCriterion': 'Eligibility rule attached to a program.',
    'Beneficiary': 'Person receiving or applying for assistance.',
    'Enrollment': 'Beneficiary application and eligibility decision for a program.',
    'BeneficiaryDocument': 'Uploaded evidence and review/replacement history.',
    'BiometricConsent': 'Time-bound consent and retention decision.',
    'BiometricData': 'Encrypted face embedding and enrollment state.',
    'BiometricDuplicateCase': 'Possible cross-record face match requiring independent review.',
    'BiometricVerificationAttempt': 'Claim verification outcome and processor metadata.',
    'WalletAccount': 'Closed-loop simulated beneficiary balance.',
    'Distribution': 'Assistance event and physical or simulated delivery mode.',
    'DistributionSlot': 'Event session, location, service area, and capacity.',
    'DistributionAllocation': 'Beneficiary place in a distribution event.',
    'Schedule': 'Allocation appointment and queue number.',
    'QrToken': 'Hashed one-time QR credential.',
    'QrScanLog': 'QR attempt result and scanning actor.',
    'Claim': 'Verified/released/settled assistance claim.',
    'ClaimSignature': 'Encrypted signature fallback evidence.',
    'ClaimReceipt': 'Issuable snapshot of final claim evidence.',
    'ClaimDispute': 'Contested claim and review outcome.',
    'Transaction': 'Simulated wallet credit/debit/transfer/reversal ledger entry.',
    'Notification': 'Queued, sent, or failed beneficiary message.',
    'StaffNotification': 'Staff inbox event.',
    'ChatbotSession': 'Public help conversation, linkage, ownership, and status.',
    'ChatbotMessage': 'Redacted conversation or staff reply.',
    'AuditLog': 'Staff action and record change history.',
}
out = [
    '# GarantiyAid current data dictionary',
    '',
    f'Generated from `prisma/schema.prisma` on {date.today():%d %B %Y}. The schema, not the earlier 22-entity image, is the implementation source. This catalog lists all {len(models)} Prisma models and their stored scalar/enum fields. Relation properties are omitted because their foreign-key columns appear below. Nullable `?` and arrays `[]` follow Prisma notation. Sensitive values such as password hashes, reset-token hashes, QR hashes, encrypted biometric templates, signatures, and contact details must not appear in public exports or screenshots.',
    '',
]
for name, body in models:
    table = re.search(r'@@map\("([^"]+)"\)', body)
    dbtable = table.group(1) if table else name
    fk = set()
    for match in re.finditer(r'@relation\([^)]*fields:\s*\[([^\]]+)\]', body):
        fk.update(x.strip() for x in match.group(1).split(','))
    out += [f'## {name}', '', f'{purposes.get(name, "Stored application record.")} Physical table: `{dbtable}`.', '',
            '| Field | Type | Storage and constraint |', '| --- | --- | --- |']
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith('//') or line.startswith('@@'):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        field, typ = parts[:2]
        if typ.rstrip('?[]') in names or not re.match(r'^[A-Za-z]\w*$', field):
            continue
        physical = re.search(r'@map\("([^"]+)"\)', line)
        rules = []
        if physical:
            rules.append('column `' + physical.group(1) + '`')
        if '@id' in line:
            rules.append('PK')
        if '@unique' in line:
            rules.append('unique')
        if field in fk:
            rules.append('FK')
        if '@default(' in line:
            default = re.search(r'@default\((\w+\(\)|[^)]+)\)', line)
            if default:
                rules.append('default `' + default.group(1) + '`')
        if typ.endswith('?'):
            rules.append('nullable')
        out.append(f'| `{field}` | `{typ}` | {"; ".join(rules) or "required"} |')
    constraints = [x.strip() for x in body.splitlines() if x.strip().startswith(('@@unique', '@@index'))]
    if constraints:
        out += ['', 'Composite constraints: ' + '; '.join('`' + x + '`' for x in constraints) + '.']
    out.append('')
assert models and 'default `uuid()`' in '\n'.join(out)
(root / 'docs/garantiyaid-data-dictionary-2026-09-24.md').write_text('\n'.join(out), encoding='utf-8')
print(f'Generated {len(models)} model sections and {sum(x.startswith("| `") for x in out)} field rows.')
