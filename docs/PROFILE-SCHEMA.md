# Statement type schema (v1)

Every module and design uses this shape. Stored as JSON in
`chrome.storage.local` under the key `profiles`. `src/core/profiles.js` is
the source of truth; this is a readable summary.

```json
{
  "schemaVersion": 1,
  "id": "uuid",
  "bank": "Meridian Bank",
  "statementType": "savings",          // savings | current | credit_card | other
  "fileType": "csv",                   // csv | pdf | xlsx
  "country": "SG",
  "defaultCurrency": "SGD",
  "name": "Meridian Bank savings, CSV", // display name (bank + type + fileType)
  "builtIn": false,
  "versions": [
    {
      "id": "uuid",
      "createdAt": "2026-09-16T00:00:00Z",
      "signatures": {                   // used for matching
        "headerText": ["Transaction Date", "Reference", "Debit Amount", "Credit Amount"],
        "preambleKeywords": ["Account Details For:"],
        "pdfAnchors": ["Statement of Account", "Meridian Bank"],
        "filenamePattern": "^meridian.*\\.csv$"
      },
      "csv": {
        "encoding": "auto", "delimiter": "auto",
        "headerRow": 5,                 // 0-based index into raw rows
        "skipRowsBefore": 5,
        "footerRules": [{ "type": "startsWith", "value": "Total" }],
        "ignoreRowRules": [{ "type": "regex", "value": "^Balance brought forward" }]
      },
      "pdf": {
        "rowModel": "columns",          // columns | grouped - see core/pdf.js; defaults to "columns" when absent
        "tableStart": { "anchor": "Transaction Date" },
        "tableEnd": { "anchor": "Closing Balance" },
        "columns": [{ "field": "date", "x0": 40, "x1": 110 }, { "field": "description_raw", "x0": 110, "x1": 330 }],
        "rowStartPattern": "^\\d{2}/\\d{2}",
        "joinWrappedLines": true,
        "ignoreLinePatterns": ["^Page \\d+ of"],
        "yearSource": "statementPeriod", // statementPeriod | column | fixed
        "statementPeriodPattern": "Statement Period: (.+?) to (.+)",
        "balanceLocation": { "opening": "Balance B/F", "closing": "Balance C/F" }
      },
      "fields": {                         // source column -> standard field
        "date":            { "source": "Transaction Date" },
        "post_date":       { "source": null },
        "description_raw": { "source": ["Reference", "Transaction Ref1", "Transaction Ref2"], "join": " " },
        "amount":          { "debit": "Debit Amount", "credit": "Credit Amount" },
        "balance":         { "source": "Balance" },
        "currency":        { "mode": "profileDefault" },   // column | header | profileDefault
        "reference":       { "source": null },
        "extra":           [{ "source": "Category", "name": "extra_category" }]
      },
      "transforms": [{ "field": "description_raw", "op": "trim" }],
      "dateFormat": "DD/MM/YYYY",
      "numberFormat": "1,234.56",          // 1,234.56 | 1.234,56
      "signConvention": "debitCredit"      // signed | debitCredit | crdr | negativeIsOut | positiveIsOut
    }
  ]
}
```

`rowModel: "grouped"` (an app-export style PDF with no fixed table - a
date-group line followed by two-line transactions, like a "Transaction
History" export) replaces the `columns`/`tableStart`/`tableEnd`/
`rowStartPattern` keys above with just:

```json
"pdf": {
  "rowModel": "grouped",
  "grouped": { "dateGroupPattern": "...", "amountEndPattern": "..." },
  "ignoreLinePatterns": ["^Page \\d+ of \\d+$"]
}
```

`dateGroupPattern`/`amountEndPattern` are optional - `core/pdf.js` has
tolerant working defaults built for OCR noise. `extractGroupedRows()`
always emits records keyed `date`/`description_raw`/`amount`/`currency`/
`type`, so `fields` for a grouped statement type is a fixed pass-through:

```json
"fields": {
  "date": { "source": "date" },
  "description_raw": { "source": ["description_raw"] },
  "amount": { "source": "amount" },
  "currency": { "mode": "column", "source": "currency" },
  "extra": [{ "source": "type", "name": "extra_type" }]
}
```

## Standard transaction row

Amounts are integers in minor units (e.g. cents):

```
{ row_id, date (YYYY-MM-DD), date_raw, post_date, description_raw, merchant,
  amount, currency, orig_amount, orig_currency, balance, account_label,
  bank, statement_type, reference, extra_*, source_file, source_page,
  source_line, profile_version, flags: [], excluded: false, edited: false,
  original: {} }
```

`date_raw` is the un-parsed source text for the date column, kept around so
the UI can still show something when `date` is null (an `unparseable_date`
flag).
