// Starter profiles shipped with the extension, built against the anonymised
// fixtures in test/fixtures/. These are all synthetic example banks, not
// real ones - they exist to demonstrate the parsing capabilities (grouped
// PDF layout detection, tabbed CSV parsing, CR/DR markers, debit/credit
// column pairs) that a real bank's export is likely to need. Not
// exhaustive; a real bank export may need tweaks - see PROFILE_SCHEMA.md
// and "How statement types work" in the README for how to add your own.

function v(overrides) {
  return {
    id: overrides.id,
    createdAt: '2026-09-16T00:00:00Z',
    signatures: overrides.signatures,
    csv: overrides.csv,
    pdf: overrides.pdf,
    fields: overrides.fields,
    transforms: overrides.transforms || [],
    dateFormat: overrides.dateFormat,
    numberFormat: overrides.numberFormat || '1,234.56',
    signConvention: overrides.signConvention,
    pendingPrefix: overrides.pendingPrefix,
  };
}

export function builtinProfiles() {
  return [
    {
      schemaVersion: 1, id: 'builtin-meridian-savings', bank: 'Meridian Bank', statementType: 'savings', fileType: 'csv',
      country: 'SG', defaultCurrency: 'SGD', name: 'Meridian Bank savings, CSV', builtIn: true,
      versions: [v({
        id: 'builtin-meridian-savings-v1',
        signatures: {
          headerText: ['Transaction Date', 'Reference', 'Debit Amount', 'Credit Amount', 'Balance'],
          preambleKeywords: ['Meridian Bank', 'Account Details For'],
          pdfAnchors: [],
          filenamePattern: '^meridian.*savings.*\\.csv$',
        },
        csv: { encoding: 'auto', delimiter: 'auto', headerRow: 4, skipRowsBefore: 4, footerRules: [{ type: 'startsWith', value: 'Total' }], ignoreRowRules: [] },
        fields: {
          date: { source: 'Transaction Date' },
          // Some CSV exports label this column "Transaction Ref" instead of
          // "Reference"; list both so the column still maps when the header
          // text varies (a near-miss header can still match this profile's
          // signature on preamble/filename alone, per profiles.js's
          // confidence mix).
          description_raw: { source: ['Reference', 'Transaction Ref'], join: ' ' },
          amount: { debit: 'Debit Amount', credit: 'Credit Amount' },
          balance: { source: 'Balance' },
          currency: { mode: 'profileDefault' },
        },
        dateFormat: 'DD/MM/YYYY',
        signConvention: 'debitCredit',
      }), v({
        // A second, longer CSV layout for the same kind of bank: a longer
        // preamble, an 8-row-deeper header, dates as "15 Sep 2026" rather
        // than DD/MM/YYYY, a plain "Description" column instead of
        // "Reference", a real "Currency" column instead of a fixed
        // profileDefault, and no running Balance column at all. Kept
        // alongside v1 to show how one bank can export two different shapes
        // over time - see PROFILE_SCHEMA.md's "versions" section.
        id: 'builtin-meridian-savings-v2',
        signatures: {
          headerText: ['Transaction Date', 'Value Date', 'Statement Code', 'Description', 'Supplementary Code', 'Supplementary Code Description', 'Client Reference', 'Additional Reference', 'Status', 'Currency', 'Debit Amount', 'Credit Amount'],
          preambleKeywords: ['Account Details For:', 'Available Balance:', 'Ledger Balance:'],
          pdfAnchors: [],
          filenamePattern: '^meridian.*\\.csv$',
        },
        csv: { encoding: 'auto', delimiter: 'auto', headerRow: 8, skipRowsBefore: 8, footerRules: [], ignoreRowRules: [] },
        fields: {
          date: { source: 'Transaction Date' },
          description_raw: { source: ['Description'] },
          amount: { debit: 'Debit Amount', credit: 'Credit Amount' },
          currency: { mode: 'column', source: 'Currency' },
          reference: { source: ['Client Reference', 'Additional Reference'], join: ' ' },
          extra: [{ name: 'extra_status', source: 'Status' }, { name: 'extra_statement_code', source: 'Statement Code' }],
        },
        dateFormat: 'DD MMM YYYY',
        signConvention: 'debitCredit',
      })],
    },
    {
      schemaVersion: 1, id: 'builtin-harbour-card', bank: 'Harbour Card', statementType: 'credit_card', fileType: 'csv',
      country: 'SG', defaultCurrency: 'SGD', name: 'Harbour Card credit card, CSV', builtIn: true,
      versions: [v({
        id: 'builtin-harbour-card-v1',
        signatures: {
          headerText: ['Transaction Date', 'Posting Date', 'Description', 'Amount'],
          preambleKeywords: ['Harbour Card', 'Cardmember'],
          pdfAnchors: [],
          filenamePattern: '^harbour.*\\.csv$',
        },
        csv: { encoding: 'auto', delimiter: 'auto', headerRow: 3, skipRowsBefore: 3, footerRules: [], ignoreRowRules: [] },
        fields: {
          date: { source: 'Transaction Date' },
          post_date: { source: 'Posting Date' },
          description_raw: { source: ['Description'] },
          amount: { source: 'Amount' },
          currency: { mode: 'profileDefault' },
        },
        dateFormat: 'DD/MM/YYYY',
        signConvention: 'positiveIsOut', // purchases are positive in this export shape.
      }), v({
        id: 'builtin-harbour-card-v2-crdr',
        // A second credit-card CSV shape: no Posting Date column, an
        // "Amount (SGD)" column whose values carry a trailing CR/DR marker
        // (amount.js already strips and reports it), and statement summary
        // lines ("Current balance", "Available credit limit", "Reward
        // points available") with no date column at all. signConvention
        // stays positiveIsOut for a plain positive amount with no marker;
        // normalize.js's CR/DR override takes precedence whenever a marker
        // is present, which every row here has.
        signatures: {
          headerText: ['Transaction Date', 'Description', 'Amount (SGD)'],
          preambleKeywords: ['Harbour Card', 'Cardmember'],
          pdfAnchors: [],
          filenamePattern: '^harbour.*\\.csv$',
        },
        csv: { encoding: 'auto', delimiter: 'auto', headerRow: 3, skipRowsBefore: 3, footerRules: [], ignoreRowRules: [] },
        fields: {
          date: { source: 'Transaction Date' },
          description_raw: { source: ['Description'] },
          amount: { source: 'Amount (SGD)' },
          currency: { mode: 'profileDefault' },
        },
        dateFormat: 'DD/MM/YYYY',
        signConvention: 'positiveIsOut',
      })],
    },
    {
      schemaVersion: 1, id: 'builtin-riverside-savings', bank: 'Riverside Bank', statementType: 'savings', fileType: 'csv',
      country: 'SG', defaultCurrency: 'SGD', name: 'Riverside Bank savings, CSV', builtIn: true,
      versions: [v({
        id: 'builtin-riverside-savings-v1',
        signatures: {
          headerText: ['Transaction Date', 'Value Date', 'Description', 'Withdrawal', 'Deposit', 'Balance'],
          preambleKeywords: ['Riverside Bank'],
          pdfAnchors: [],
          filenamePattern: '^riverside.*\\.csv$',
        },
        csv: { encoding: 'auto', delimiter: 'auto', headerRow: 3, skipRowsBefore: 3, footerRules: [], ignoreRowRules: [] },
        fields: {
          date: { source: 'Transaction Date' },
          post_date: { source: 'Value Date' },
          description_raw: { source: ['Description'] },
          amount: { debit: 'Withdrawal', credit: 'Deposit' },
          balance: { source: 'Balance' },
          currency: { mode: 'profileDefault' },
        },
        dateFormat: 'DD/MM/YYYY',
        signConvention: 'debitCredit',
      })],
    },
    {
      schemaVersion: 1, id: 'builtin-summit-savings', bank: 'Summit Bank', statementType: 'savings', fileType: 'csv',
      country: 'SG', defaultCurrency: 'SGD', name: 'Summit Bank savings, CSV', builtIn: true,
      versions: [v({
        id: 'builtin-summit-savings-v1',
        signatures: {
          headerText: ['Date', 'Description', 'Withdrawal (SGD)', 'Deposit (SGD)', 'Balance (SGD)'],
          preambleKeywords: ['Summit Bank Limited', 'STATEMENT OF ACCOUNT'],
          pdfAnchors: [],
          filenamePattern: '^summit.*\\.csv$',
        },
        // An unusual layout: a long preamble before the header row.
        csv: { encoding: 'auto', delimiter: 'auto', headerRow: 9, skipRowsBefore: 9, footerRules: [], ignoreRowRules: [] },
        fields: {
          date: { source: 'Date' },
          description_raw: { source: ['Description'] },
          amount: { debit: 'Withdrawal (SGD)', credit: 'Deposit (SGD)' },
          balance: { source: 'Balance (SGD)' },
          currency: { mode: 'profileDefault' },
        },
        dateFormat: 'DD/MM/YYYY',
        signConvention: 'debitCredit',
      })],
    },
    {
      schemaVersion: 1, id: 'builtin-anchor-checking', bank: 'Anchor Bank', statementType: 'current', fileType: 'csv',
      country: 'US', defaultCurrency: 'USD', name: 'Anchor Bank checking, CSV', builtIn: true,
      versions: [v({
        id: 'builtin-anchor-checking-v1',
        signatures: {
          headerText: ['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance'],
          preambleKeywords: [],
          pdfAnchors: [],
          filenamePattern: '^anchor.*\\.csv$',
        },
        csv: { encoding: 'auto', delimiter: 'auto', headerRow: 0, skipRowsBefore: 0, footerRules: [], ignoreRowRules: [] },
        fields: {
          date: { source: 'Posting Date' },
          description_raw: { source: ['Description'] },
          amount: { source: 'Amount' },
          balance: { source: 'Balance' },
          reference: { source: 'Check or Slip #' },
          currency: { mode: 'profileDefault' },
        },
        dateFormat: 'MM/DD/YYYY',
        signConvention: 'signed', // already signs debits negative, credits positive.
      })],
    },
    {
      schemaVersion: 1, id: 'builtin-lattice-card', bank: 'Lattice Bank', statementType: 'credit_card', fileType: 'csv',
      country: 'SG', defaultCurrency: 'SGD', name: 'Lattice Bank credit card, CSV', builtIn: true,
      versions: [v({
        // A "Download as CSV" export where every line - including the
        // header - is padded with three (sometimes five, on a
        // foreign-currency row) leading tabs, with tab-only lines used as
        // row separators, and a card-type line plus a "Transaction
        // History:" preamble line above the header. csv.js's line trimming
        // strips the padding and drops the blank separator lines before
        // this ever sees a grid, so headerRow/skipRowsBefore below are
        // plain small indices, not tab-aware. Amounts read "SGD 6.00 DR" /
        // "SGD 200.00 CR" (amount.js already strips the currency letters
        // and trailing marker); a foreign-currency row additionally carries
        // "USD 65.00" in its own column, kept as an extra column rather
        // than fed into 'amount' (see suggest.js's isForeignAmountHeader -
        // that column would otherwise tie with "SGD Amount" for the
        // primary amount field and win by column order, leaving every
        // local-currency row with no amount at all). A "[UNPOSTED]" prefix
        // on the description marks a transaction not yet posted;
        // pendingPrefix below tags those rows 'pending' (informational,
        // never a warning) without altering description_raw.
        id: 'builtin-lattice-card-v1',
        signatures: {
          headerText: ['Date', 'DESCRIPTION', 'Foreign Currency Amount', 'SGD Amount'],
          preambleKeywords: ['Transaction History:', 'LATTICE PLATINUM CARD'],
          pdfAnchors: [],
          filenamePattern: '',
        },
        csv: { encoding: 'auto', delimiter: 'auto', headerRow: 2, skipRowsBefore: 2, footerRules: [], ignoreRowRules: [] },
        fields: {
          date: { source: 'Date' },
          description_raw: { source: ['DESCRIPTION'] },
          amount: { source: 'SGD Amount' },
          currency: { mode: 'profileDefault' },
          extra: [{ name: 'extra_foreign_currency_amount', source: 'Foreign Currency Amount' }],
        },
        dateFormat: 'DD/MM/YYYY',
        signConvention: 'crdr', // every row carries a CR/DR marker, which always overrides the declared convention (normalize.js resolveAmount) - crdr just names what's actually going on.
        pendingPrefix: '[UNPOSTED]',
      })],
    },
    {
      schemaVersion: 1, id: 'builtin-northwind-transaction-history-pdf', bank: 'Northwind Bank', statementType: 'savings', fileType: 'pdf',
      country: 'SG', defaultCurrency: 'SGD', name: 'Northwind Bank savings, Transaction History PDF', builtIn: true,
      versions: [v({
        id: 'builtin-northwind-transaction-history-pdf-v1',
        // An app-generated "Transaction History" export (not a classic
        // scanned monthly statement): no fixed table columns, instead a
        // date-group line ("Yesterday, 15 Sep 2026") followed by two-line
        // transactions (description+amount, then a type line). See
        // core/pdf.js's extractGroupedRows / rowModel 'grouped'.
        signatures: {
          headerText: [],
          preambleKeywords: ['Transaction History', 'Northwind Current Account', 'Available Balance', 'Ledger Balance'],
          pdfAnchors: ['Transaction History'],
          filenamePattern: '',
        },
        // A per-page footer ("Page 2 of 3") and a balance-summary line
        // carrying "Transactions as of:" are neither a date-group nor an
        // amount-ending line, so without this both would silently merge
        // into the *next* transaction's `type` field (extractGroupedRows's
        // continuation-line fallback) instead of being dropped.
        // "Available Balance"/"Ledger Balance" additionally guard against
        // matchAmountEnd's optional sign: an unsigned balance figure like
        // "Available Balance: SGD 8,214.12" ends in exactly the same
        // currency+number shape a signless credit line does, and would
        // otherwise be mistaken for a transaction. The preamble (address,
        // account/postal numbers, statement period, balance summary) is
        // skipped structurally: extractGroupedRows never treats a line as a
        // transaction until the first date-group line has opened.
        // ignoreLinePatterns below is for phrases that could still appear
        // WITHIN the transaction list itself (a running balance line
        // between transactions); core/pdf.js's NON_TRANSACTION_PHRASES_RE
        // already covers these same phrases as a profile-independent
        // default, this list is redundant-but-explicit.
        // trailingTypeLine: true - this layout's own line right after the
        // amount is a real type/category line ("Point-of-Sale Transaction ·
        // POS"), not the start of the next transaction's description; see
        // core/pdf.js's extractGroupedRows doc comment for why this is
        // opt-in rather than every grouped PDF's default.
        pdf: { rowModel: 'grouped', grouped: { trailingTypeLine: true }, ignoreLinePatterns: ['^Page \\d+ of \\d+$', 'Transactions as of', 'Available Balance', 'Ledger Balance', 'Current balance', 'Available credit limit', 'Reward points', 'Total', 'Subtotal'] },
        fields: {
          date: { source: 'date' },
          description_raw: { source: ['description_raw'] },
          amount: { source: 'amount' },
          currency: { mode: 'column', source: 'currency' },
          extra: [{ name: 'extra_type', source: 'type' }],
        },
        dateFormat: 'DD MMM YYYY',
        signConvention: 'signed', // extractGroupedRows already signs from the +/- marker.
      })],
    },
  ];
}
