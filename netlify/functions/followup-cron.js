import { getStore } from '@netlify/blobs';

const SEQUENCE_DAYS = [3, 7, 14];

function addDaysIso(fromIso, days) {
  const d = new Date(fromIso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function messageForStep(step, f, studioName) {
  const saluto = f.clienteNome ? `Gentile ${f.clienteNome},` : 'Gentile Cliente,';
  const rif = f.numero ? ` (rif. preventivo n. ${f.numero})` : '';
  const bodies = [
    `${saluto}<br><br>Le scriviamo in merito al preventivo${rif} che le abbiamo recentemente presentato. Resta a sua disposizione per qualsiasi chiarimento o approfondimento.<br><br>Cordiali saluti,<br>${studioName}`,
    `${saluto}<br><br>Non avendo ricevuto sue notizie riguardo al preventivo${rif}, le scriviamo per sapere se ha avuto modo di valutarlo o se ha bisogno di ulteriori informazioni.<br><br>Cordiali saluti,<br>${studioName}`,
    `${saluto}<br><br>Le scriviamo un'ultima volta riguardo al preventivo${rif}. Se nel frattempo le esigenze fossero cambiate o avesse scelto diversamente, ci farebbe piacere saperlo. Restiamo comunque a disposizione.<br><br>Cordiali saluti,<br>${studioName}`
  ];
  const subjects = [
    `Preventivo${f.numero ? ' n. ' + f.numero : ''} — un aggiornamento?`,
    `Preventivo${f.numero ? ' n. ' + f.numero : ''} — siamo ancora a disposizione`,
    `Preventivo${f.numero ? ' n. ' + f.numero : ''} — ultimo promemoria`
  ];
  return { subject: subjects[step - 1] || subjects[0], html: bodies[step - 1] || bodies[0] };
}

export default async (req) => {
  const licensesStore = getStore('licenses');
  const followupsStore = getStore('followups');
  const dataStore = getStore('studio-data');

  const { blobs } = await licensesStore.list();
  let sent = 0;
  let skippedNoKey = 0;
  let errors = 0;

  for (const b of blobs) {
    const key = b.key;
    let list;
    try {
      list = await followupsStore.get(key, { type: 'json' });
    } catch (e) { continue; }
    if (!Array.isArray(list) || list.length === 0) continue;

    const dueEntries = list.filter(f => f.active && f.step < SEQUENCE_DAYS.length && new Date(f.nextDueAt) <= new Date());
    if (dueEntries.length === 0) continue;

    const studioData = await dataStore.get(key, { type: 'json' });
    const settings = (studioData && studioData.studioSettings) || {};
    const resendKey = settings.resendApiKey;
    const fromEmail = settings.resendFromEmail;
    const fromName = settings.resendFromName || settings.nome || 'Studio';

    if (!resendKey || !fromEmail) {
      skippedNoKey += dueEntries.length;
      continue;
    }

    let changed = false;
    for (const entry of dueEntries) {
      const nextStep = entry.step + 1;
      const { subject, html } = messageForStep(nextStep, entry, fromName);
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${resendKey}`
          },
          body: JSON.stringify({
            from: `${fromName} <${fromEmail}>`,
            to: entry.clienteEmail,
            subject,
            html,
            tags: [
              { name: 'followup_id', value: entry.id },
              { name: 'license_key', value: key.toLowerCase() }
            ]
          })
        });
        if (res.ok) {
          entry.step = nextStep;
          entry.events.push({ type: 'inviato_followup_' + nextStep, at: new Date().toISOString() });
          if (nextStep < SEQUENCE_DAYS.length) {
            entry.nextDueAt = addDaysIso(entry.startedAt, SEQUENCE_DAYS[nextStep]);
          } else {
            entry.active = false;
            entry.events.push({ type: 'sequenza_conclusa', at: new Date().toISOString() });
          }
          sent += 1;
          changed = true;
        } else {
          errors += 1;
        }
      } catch (e) {
        errors += 1;
      }
    }
    if (changed) {
      await followupsStore.setJSON(key, list);
    }
  }

  return new Response(JSON.stringify({ ok: true, sent, skippedNoKey, errors }), { status: 200 });
};

export const config = {
  schedule: '@daily'
};
