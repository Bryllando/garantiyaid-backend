ALTER TABLE "programs" ADD COLUMN "other_required_document_names" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "programs" SET "other_required_document_names" = ARRAY[BTRIM("other_required_document_name")]
WHERE 'OTHER' = ANY("required_document_types") AND NULLIF(BTRIM("other_required_document_name"), '') IS NOT NULL;
ALTER TABLE "beneficiary_documents" ADD COLUMN "document_name" VARCHAR(150);
