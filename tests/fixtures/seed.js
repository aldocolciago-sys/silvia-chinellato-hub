/**
 * Costruttori di dati di esempio e conversione in documenti Firestore (percorso → dati)
 * per il mock in-memory. Usato sia dai test jsdom sia dagli E2E Playwright.
 */
export const APP_ID = 'silvia-chinellato-app';
export const SHARED = `artifacts/${APP_ID}/shared/data`;
export const PUBLIC = `artifacts/${APP_ID}/public/data`;

export const AUTHORIZED_EMAIL = 'silviachine@gmail.com';
export const SECOND_AUTHORIZED_EMAIL = 'aldo.colciago@gmail.com';
export const UNAUTHORIZED_EMAIL = 'intruso@example.com';

/** Marcatori che segnano come già eseguite le migrazioni una-tantum. */
export const MIGRATION_MARKERS = {
    [`${SHARED}/_meta/clinical-sessions-migration-v1`]: { completed: true },
    [`${SHARED}/_meta/patient-notes-clinical-blocks-migration-v2`]: { completed: true },
    [`${SHARED}/_meta/legacy-migration-uid-${AUTHORIZED_EMAIL}`]: { completed: true },
    [`${SHARED}/_meta/legacy-migration-uid-${SECOND_AUTHORIZED_EMAIL}`]: { completed: true }
};

export function center(overrides = {}) {
    return {
        id: 'c1', name: 'Centro Polisalute', service: 'Osteopatia', color: '#3f5e4e', icon: 'fa-hospital',
        icalUrl: '', showPublic: true, includeInFinance: true, isNonClinicalCalendar: false,
        address: 'Via Roma 10, Milano', phone: '02 1234567', siteUrl: 'https://example.com', bookingUrl: 'https://example.com/book',
        ...overrides
    };
}

export function patient(overrides = {}) {
    return {
        id: 'pat_1', name: 'Mario Rossi', phone: '333 1234567', email: 'mario@example.com',
        notes: '', currentIssues: '', goals: '', allergies: '', medications: '', tags: [], recallDays: 120,
        ...overrides
    };
}

export function studioEvent(overrides = {}) {
    const { extendedProps, ...rest } = overrides;
    return {
        id: 'evt_1', title: 'Visita / Trattamento - Mario Rossi',
        start: '2030-01-15T09:00:00', end: '2030-01-15T10:00:00',
        backgroundColor: '#3f5e4e', borderColor: '#3f5e4e', textColor: '#ffffff',
        ...rest,
        extendedProps: { centerId: null, centerName: 'Studio Privato', patientId: null, fee: 0, paymentStatus: 'paid', paymentMethod: 'cash', clinicalNote: '', clinicalOutcome: '', isNonClinical: false, ...(extendedProps || {}) }
    };
}

/**
 * Converte uno stato applicativo in documenti Firestore.
 * @param {object} data
 * @param {boolean} [data.skipMigrations=true] aggiunge i marcatori per saltare le migrazioni
 */
export function seedDocs({
    centers, patients = [], events = [], clinicalSessions = [], manualRevenues = [], taxProfile = null,
    treatments, news, preparations, publicCenters, skipMigrations = true, extra = {}
} = {}) {
    const docs = {};
    if (skipMigrations) Object.assign(docs, MIGRATION_MARKERS);
    for (const c of centers || []) docs[`${SHARED}/centers_list/${c.id}`] = c;
    for (const c of publicCenters || centers || []) docs[`${PUBLIC}/centers_list/${c.id}`] = c;
    for (const p of patients) docs[`${SHARED}/patients_list/${p.id}`] = p;
    for (const e of events) docs[`${SHARED}/studio_events/${e.id}`] = e;
    for (const s of clinicalSessions) docs[`${SHARED}/clinical_sessions/${s.eventId || s.id}`] = s;
    for (const r of manualRevenues) docs[`${SHARED}/manual_revenue/${r.id}`] = r;
    if (taxProfile) docs[`${SHARED}/tax_profile/default`] = taxProfile;
    for (const t of treatments || []) docs[`${PUBLIC}/treatments_list/${t.id}`] = t;
    for (const n of news || []) docs[`${PUBLIC}/news_list/${n.id}`] = n;
    for (const p of preparations || []) docs[`${PUBLIC}/preparations_list/${p.id}`] = p;
    return { ...docs, ...extra };
}
