# Big Bets

Ein Nachrichten-Wächter für **seltene, marktbewegende Ereignisse** („Big Bets“), zum Beispiel: Militärschlag am Golf → Öl ↑; Lockerung der Krypto-Regulierung → Bitcoin ↑; überraschende Zinsentscheidung → Währung und Gold.

Alle 5 Minuten liest der Wächter Nachrichten aus rund 25 Quellen weltweit. Claude Haiku sortiert vor, Claude Opus prüft streng. Bei einem echten Big Bet kommt eine **Push-Nachricht als Einzeiler** aufs Handy:

```
🛢️ LONG Öl (Brent) · USA greifen Iran an · hoch · Tage
Bereits: Brent-Öl +4,2 % heute
```

Antippen öffnet die Mini-App mit Begründung, Risiken, Folgen zweiter Ordnung, Kursänderung und Quellen. Dort kopierst du den Ticker für deinen Broker.

> ⚠️ Keine Anlageberatung. Ereignisse können anders ausgehen als erwartet, und die schnellsten Marktteilnehmer reagieren in Sekunden. Setze immer einen Stop-Loss.

## Einrichtung (einmalig, ca. 15 Minuten)

1. **Repository öffentlich machen:** *Settings → General → Danger Zone → Change visibility → Public*.
2. **GitHub Pages einschalten:** *Settings → Pages → Source:* **GitHub Actions**.
3. **API-Key anlegen:** auf https://console.anthropic.com
   - Guthaben aufladen.
   - Unter *Limits* ein Monatslimit setzen.
   - Unter *API Keys* einen Schlüssel erstellen.
4. **ntfy einrichten:** App „ntfy“ installieren (iOS/Android). Einen **geheimen, zufälligen Kanalnamen** ausdenken, z. B. `bigbets-7f3k9q2xw1`. In der App auf **+** tippen und genau diesen Namen abonnieren. Wer den Namen kennt, bekommt deine Pushes, also nicht weitergeben.
5. **Secrets eintragen:** *Settings → Secrets and variables → Actions → New repository secret*
   - `ANTHROPIC_API_KEY` = dein API-Key
   - `NTFY_TOPIC` = dein Kanalname
6. **Mergen** des Pull Requests nach `main`.
7. **Test:** *Actions → Big Bets → Run workflow*, Haken bei „Nur eine Test-Benachrichtigung senden“. Aufs Handy sollte kommen: „✅ Big-Bets-Wächter ist eingerichtet“.
8. **App aufs Handy:** https://marcusgrundmann90-hub.github.io/Trading-/ öffnen, dann *Teilen → Zum Home-Bildschirm*.

Ab dann läuft der Wächter automatisch. Big Bets sind selten: Es kann Tage dauern, bis die erste Nachricht kommt.

## Einstellungen (optional)
Unter *Settings → Secrets and variables → Actions → Variables*:

| Variable | Default | Bedeutung |
|---|---|---|
| `ALERT_MIN_CONFIDENCE` | 75 | Ab welcher Konfidenz (0–100) gepusht wird. Höher = seltener, aber treffsicherer. |
| `MAX_ASSESS_PER_DAY` | 15 | Maximale Zahl gründlicher Prüfungen durch Claude Opus pro Tag. Das ist die wichtigste Kostenbremse. |

## Kosten
- **GitHub:** kostenlos (öffentliches Repo).
- **ntfy:** kostenlos.
- **Anthropic-API:** nutzungsabhängig, geschätzt:
  - Vorsortieren: etwa 0,10 $ pro Tag.
  - Eine gründliche Prüfung: etwa 0,10 $.
  - Mit dem Default-Limit von 15 Prüfungen pro Tag sind das höchstens etwa 1,70 $ pro Tag (rund 50 $ im Monat). An ruhigen Tagen ist es deutlich weniger.
  - Setz in der Anthropic-Konsole zusätzlich ein Monatslimit.

## Grenzen
- GitHub startet zeitgesteuerte Läufe oft mit einigen Minuten Verspätung. Der Wächter ist für Trades mit **Tagen bis Wochen Horizont** gedacht, nicht für Sekunden-Reaktionen.
- Bei öffentlichen Repos pausiert GitHub Zeitpläne nach 60 Tagen ohne Commit auf `main`. Dann unter *Actions* den Workflow wieder aktivieren.
- Die Mini-App zeigt oben „Letzter Check vor X Min.“. Steht dort länger als 30 Minuten nichts Neues, läuft der Wächter vermutlich nicht.

## Aufbau
| Teil | Pfad |
|---|---|
| Spezifikation | `docs/BIGBETS.md` |
| Wächter (Python) | `bot/` – `feeds.py` Quellen, `triage.py` Vorsortierung, `assess.py` Bewertung, `prices.py` Kurscheck, `notify.py` Push |
| Zeitplan | `.github/workflows/bigbets.yml` (Zustand und Alarme liegen auf dem Branch `data`) |
| Mini-App | `web/`, veröffentlicht über `.github/workflows/pages.yml` |
| Tests | `pip install -r bot/requirements.txt pytest && python -m pytest bot/tests` |
