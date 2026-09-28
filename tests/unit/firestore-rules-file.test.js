import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ROOT, constSource } from '../support/app-source.js';

const rules = readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

describe('firestore.rules', () => {
    it('autorizza gli stessi account dell\'app (AUTHORIZED_EMAILS)', () => {
        // eslint-disable-next-line no-new-func
        const appEmails = new Function(`${constSource('AUTHORIZED_EMAILS')}\nreturn AUTHORIZED_EMAILS;`)();
        const rulesEmails = JSON.parse(rules.match(/request\.auth\.token\.email in (\[[^\]]+\])/)[1].replace(/'/g, '"'));
        expect([...rulesEmails].sort()).toEqual([...appEmails].map(e => e.toLowerCase()).sort());
    });

    it('richiede l\'email verificata per gli amministratori', () => {
        expect(rules).toContain('request.auth.token.email_verified == true');
    });

    it('non contiene regole aperte a qualunque utente autenticato', () => {
        expect(rules).not.toMatch(/allow (read, )?write: if request\.auth != null;/);
        expect(rules).not.toMatch(/allow [a-z, ]+: if true;[\s\S]*?allow write: if true/);
    });
});
