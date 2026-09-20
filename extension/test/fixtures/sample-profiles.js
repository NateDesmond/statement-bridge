// Test-only profile fixtures. These used to ship as builtin-profiles.js's
// shipped list (NO-TEMPLATES.md item 1 removed all shipped profiles - every
// real profile is now created by a user through the wizard); this module
// keeps the same shapes purely as test data, simulating "a user already
// saved this statement type", so matching/parsing coverage against these
// realistic layouts isn't lost. See test/fixtures/*.csv|pdf for the files
// these are shaped to match, and PROFILE_SCHEMA.md for the field vocabulary.

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

export function sampleProfiles() {
  return [
    {
      schemaVersion: 1, id: 'sample-meridian-savings', bank: 'Meridian Bank', statementType: 'savings', fileType: 'csv',
      country: 'SG', defaultCurrency: 'SGD', name: 'Meridian Bank savings, CSV', builtIn: false,
      versions: [v({
        id: 'sample-meridian-savings-v1',
        signatures: {
          headerText: ['Transaction Date', 'Reference', 'Debit Amount', 'Credit Amount', 'Balance'],
          preambleKeywords: ['Meridian Bank', 'Account Details For'],
          pdfAnchors: [],
          filenamePattern: '^meridian.*savings.*\\.csv$',
        },
        csv: { encoding: 'auto', delimiter: 'auto', headerRow: 4, skipRowsBefore: 4, footerRules: [{ type: 'startsWith', value: 'Total' }], ignoreRowRules: [] },
        fields: {
          date: { source: 'Transaction Date' },
          description_raw: { source: ['Reference', 'Transaction Ref'], join: ' ' },
          amount: { debit: 'Debit Amount', credit: 'Credit Amount' },
          balance: { source: 'Balance' },
          currency: { mode: 'profileDefault' },
        },
        dateFormat: 'DD/MM/YYYY',
        signConvention: 'debitCredit',
      }), v({
        id: 'sample-meridian-savings-v2',
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
      schemaVersion: 1, id: 'sample-harbour-card', bank: 'Harbour Card', statementType: 'credit_card', fileType: 'csv',
      country: 'SG', defaultCurrency: 'SGD', name: 'Harbour Card credit card, CSV', builtIn: false,
      versions: [v({
        id: 'sample-harbour-card-v1',
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
        signConvention: 'positiveIsOut',
      }), v({
        id: 'sample-harbour-card-v2-crdr',
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
      schemaVersion: 1, id: 'sample-riverside-savings', bank: 'Riverside Bank', statementType: 'savings', fileType: 'csv',
      country: 'SG', defaultCurrency: 'SGD', name: 'Riverside Bank savings, CSV', builtIn: false,
      versions: [v({
        id: 'sample-riverside-savings-v1',
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
      schemaVersion: 1, id: 'sample-summit-savings', bank: 'Summit Bank', statementType: 'savings', fileType: 'csv',
      country: 'SG', defaultCurrency: 'SGD', name: 'Summit Bank savings, CSV', builtIn: false,
      versions: [v({
        id: 'sample-summit-savings-v1',
        signatures: {
          headerText: ['Date', 'Description', 'Withdrawal (SGD)', 'Deposit (SGD)', 'Balance (SGD)'],
          preambleKeywords: ['Summit Bank Limited', 'STATEMENT OF ACCOUNT'],
          pdfAnchors: [],
          filenamePattern: '^summit.*\\.csv$',
        },
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
      schemaVersion: 1, id: 'sample-anchor-checking', bank: 'Anchor Bank', statementType: 'current', fileType: 'csv',
      country: 'US', defaultCurrency: 'USD', name: 'Anchor Bank checking, CSV', builtIn: false,
      versions: [v({
        id: 'sample-anchor-checking-v1',
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
        signConvention: 'signed',
      })],
    },
    {
      schemaVersion: 1, id: 'sample-lattice-card', bank: 'Lattice Bank', statementType: 'credit_card', fileType: 'csv',
      country: 'SG', defaultCurrency: 'SGD', name: 'Lattice Bank credit card, CSV', builtIn: false,
      versions: [v({
        id: 'sample-lattice-card-v1',
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
        signConvention: 'crdr',
        pendingPrefix: '[UNPOSTED]',
      })],
    },
    {
      schemaVersion: 1, id: 'sample-northwind-transaction-history-pdf', bank: 'Northwind Bank', statementType: 'savings', fileType: 'pdf',
      country: 'SG', defaultCurrency: 'SGD', name: 'Northwind Bank savings, Transaction History PDF', builtIn: false,
      versions: [v({
        id: 'sample-northwind-transaction-history-pdf-v1',
        signatures: {
          headerText: [],
          preambleKeywords: ['Transaction History', 'Northwind Current Account', 'Available Balance', 'Ledger Balance'],
          pdfAnchors: ['Transaction History'],
          filenamePattern: '',
        },
        pdf: { rowModel: 'grouped', grouped: { trailingTypeLine: true }, ignoreLinePatterns: ['^Page \\d+ of \\d+$', 'Transactions as of', 'Available Balance', 'Ledger Balance', 'Current balance', 'Available credit limit', 'Reward points', 'Total', 'Subtotal'] },
        fields: {
          date: { source: 'date' },
          description_raw: { source: ['description_raw'] },
          amount: { source: 'amount' },
          currency: { mode: 'column', source: 'currency' },
          extra: [{ name: 'extra_type', source: 'type' }],
        },
        dateFormat: 'DD MMM YYYY',
        signConvention: 'signed',
      })],
    },
  ];
}
