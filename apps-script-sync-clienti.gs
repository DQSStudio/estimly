// ===================== Sincronizza Rubrica Estimly ad ogni risposta del modulo =====================
// Come installarlo:
// 1. Apri il Google Sheet (quello collegato al modulo "Risposte del modulo 1")
// 2. Menu in alto: Estensioni → Apps Script
// 3. Cancella il contenuto di default e incolla TUTTO questo file
// 4. Sostituisci LICENSE_KEY qui sotto con la tua chiave di licenza Estimly (es. "DQSS-XXXX-XXXX-XXXX")
// 5. Salva (icona dischetto, in alto)
// 6. Nel menu a sinistra, clicca l'icona dell'orologio ("Trigger")
// 7. "+ Aggiungi trigger" in basso a destra
// 8. Imposta: Funzione da eseguire = syncEstimlyRubrica | Origine evento = Dal foglio di lavoro
//    | Tipo di evento = Al momento dell'invio del modulo
// 9. Salva e autorizza l'esecuzione quando richiesto (è il tuo stesso account Google, nessun
//    dato esce da qui se non la chiamata verso Estimly che fai già impostando questo script)
//
// Da questo momento, ogni volta che qualcuno invia il modulo, Estimly rilegge l'intero foglio
// e aggiorna la Rubrica (nuovi contatti aggiunti, contatti già esistenti - stesso nome e
// cognome o stessa email - sovrascritti con i dati più recenti).

const LICENSE_KEY = 'INSERISCI_QUI_LA_TUA_CHIAVE_DI_LICENZA';
const ESTIMLY_SYNC_URL = 'https://dsqestimly.netlify.app/.netlify/functions/clients-sheet-sync';

function syncEstimlyRubrica() {
  try {
    const res = UrlFetchApp.fetch(ESTIMLY_SYNC_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ key: LICENSE_KEY }),
      muteHttpExceptions: true
    });
    Logger.log('Risposta Estimly: ' + res.getContentText());
  } catch (err) {
    Logger.log('Errore chiamando Estimly: ' + err);
  }
}
