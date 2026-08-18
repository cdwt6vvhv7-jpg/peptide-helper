// Pure dosing / inventory math. No DOM, no state — easy to sanity-check by hand.

const Calc = {
  // mg per vial reconstituted with bacWaterMl of bac water -> concentration in mg/mL
  concentrationMgPerMl(mgPerVial, bacWaterMl) {
    if (!bacWaterMl) return 0;
    return mgPerVial / bacWaterMl;
  },

  // dose in mg -> volume in mL to draw, given concentration in mg/mL
  drawVolumeMl(doseMg, concentrationMgPerMl) {
    if (!concentrationMgPerMl) return 0;
    return doseMg / concentrationMgPerMl;
  },

  // volume in mL -> syringe units, for U-100 (100 units/mL) or U-40 (40 units/mL) insulin syringes
  syringeUnits(volumeMl, syringeType) {
    const perMl = syringeType === 'U40' ? 40 : 100;
    return volumeMl * perMl;
  },

  // syringe units -> dose in mg, given concentration in mg/mL. Inverse of
  // drawVolumeMl+syringeUnits combined — lets a dose be entered as "I want to draw 10u"
  // instead of doing the mg-per-vial/bac-water/syringe-scale math by hand.
  doseMgFromUnits(units, concentrationMgPerMl, syringeType) {
    if (!concentrationMgPerMl) return 0;
    const perMl = syringeType === 'U40' ? 40 : 100;
    return (units / perMl) * concentrationMgPerMl;
  },

  // doses per week implied by a protocol's frequency, averaged down by the
  // duty cycle (on/(on+off)) for a repeating on/off cycle — otherwise this
  // would overstate usage during off-weeks
  dosesPerWeek(protocol) {
    let base;
    switch (protocol.frequency) {
      case 'daily': base = 7; break;
      case 'eod': base = 3.5; break;
      case 'weekly': base = (protocol.daysOfWeek || []).length; break;
      default: base = 0;
    }
    if (protocol.cycleOnWeeks && protocol.cycleOffWeeks) {
      base *= protocol.cycleOnWeeks / (protocol.cycleOnWeeks + protocol.cycleOffWeeks);
    }
    return base;
  },

  // first (earliest) phase's start date — the effective start of the whole protocol
  protocolStartDate(protocol) {
    const schedule = protocol.doseSchedule || [];
    return schedule.length ? schedule[0].startDate : null;
  },

  // dose in effect on a given date, per protocol.doseSchedule (list of {startDate, doseMg},
  // sorted ascending) — supports titration by picking the latest phase that has started
  doseMgOnDate(protocol, date) {
    const schedule = protocol.doseSchedule || [];
    if (schedule.length === 0) return 0;
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    let applicable = schedule[0];
    for (const phase of schedule) {
      const phaseDate = new Date(phase.startDate + 'T00:00:00');
      phaseDate.setHours(0, 0, 0, 0);
      if (phaseDate <= d) applicable = phase;
      else break;
    }
    return applicable.doseMg;
  },

  weeklyMgUsage(protocol, date = new Date()) {
    return Calc.doseMgOnDate(protocol, date) * Calc.dosesPerWeek(protocol);
  },

  // total mg on hand across all lots for a peptide (gross acquired, not net of usage)
  totalMgOnHand(lots) {
    return lots.reduce((sum, lot) => sum + (lot.mgPerVial * lot.vials), 0);
  },

  // total mg logged as actually taken (dose log entries) for a peptide
  totalMgConsumed(logs) {
    return logs.reduce((sum, log) => sum + (log.doseMg || 0), 0);
  },

  // Attributes a peptide's aggregate consumedMg back to individual restock
  // lots, oldest dateAcquired first, so each lot can display "~N vials
  // remaining" even though doseLogs only ever records mg consumed, never
  // which specific lot it came from. Pure display math — doesn't change how
  // totalMgOnHand/totalMgConsumed track the aggregate; just a FIFO allocation
  // on top, so it assumes older stock is used up before newer stock of a
  // different strength is opened out of order.
  lotsRemaining(lots, consumedMg) {
    const sorted = lots.slice().sort((a, b) => a.dateAcquired.localeCompare(b.dateAcquired));
    let remaining = consumedMg;
    return sorted.map(lot => {
      const grossMg = lot.mgPerVial * lot.vials;
      const allocated = Math.min(Math.max(0, remaining), grossMg);
      remaining -= allocated;
      const remainingMg = Math.max(0, grossMg - allocated);
      return { lot, remainingMg, remainingVials: lot.mgPerVial ? remainingMg / lot.mgPerVial : 0 };
    });
  },

  // Walks the actual schedule forward day by day (respecting frequency, titration via
  // doseMgOnDate, and each protocol's endDate/active flag) consuming mg from netMg, rather
  // than dividing by an average weekly rate. This is what makes a finite endDate (a cycle)
  // correctly cap "doses left" instead of projecting stock forever at the current rate.
  // Returns limitedBy: 'stock' (ran out of mg before the schedule ended — stockOutDate set),
  // 'schedule' (every protocol reached its endDate before stock ran out — mgLeftover is what's
  // still on hand once dosing stops), or 'none' (no protocols to simulate).
  projectSupply(netMg, protocols, fromDate = new Date()) {
    if (!protocols || protocols.length === 0) {
      return { doses: 0, limitedBy: 'none', lastDoseDate: null, stockOutDate: null, scheduleEndDate: null, mgLeftover: netMg };
    }

    const date = new Date(fromDate);
    date.setHours(0, 0, 0, 0);
    let remaining = netMg;
    let doses = 0;
    let lastDoseDate = null;
    const maxDays = 3650 * 2; // 20-year safety cap against open-ended protocols

    for (let i = 0; i < maxDays; i++) {
      const stillActive = protocols.some(p => {
        if (!p.active) return false;
        if (!p.endDate) return true;
        const end = new Date(p.endDate + 'T00:00:00');
        end.setHours(0, 0, 0, 0);
        return date <= end;
      });
      if (!stillActive) {
        return { doses, limitedBy: 'schedule', lastDoseDate, stockOutDate: null, scheduleEndDate: lastDoseDate, mgLeftover: remaining };
      }

      let dueMg = 0, dueCount = 0;
      for (const p of protocols) {
        if (Calc.isDueOn(p, date)) {
          dueMg += Calc.doseMgOnDate(p, date);
          dueCount++;
        }
      }
      if (dueMg > 0) {
        if (dueMg > remaining + 1e-9) {
          return { doses, limitedBy: 'stock', lastDoseDate, stockOutDate: new Date(date), scheduleEndDate: null, mgLeftover: remaining };
        }
        remaining -= dueMg;
        doses += dueCount;
        lastDoseDate = new Date(date);
      }
      date.setDate(date.getDate() + 1);
    }
    // Hit the cap: an open-ended protocol whose stock will outlast 20 years at this rate.
    return { doses, limitedBy: 'stock', lastDoseDate, stockOutDate: null, scheduleEndDate: null, mgLeftover: remaining };
  },

  // does a protocol have a dose due on the given date? (date = Date object, time stripped)
  isDueOn(protocol, date) {
    if (!protocol.active) return false;
    const startDate = Calc.protocolStartDate(protocol);
    if (!startDate) return false;
    const start = new Date(startDate + 'T00:00:00');
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    start.setHours(0, 0, 0, 0);
    if (d < start) return false;
    if (protocol.endDate) {
      const end = new Date(protocol.endDate + 'T00:00:00');
      end.setHours(0, 0, 0, 0);
      if (d > end) return false;
    }

    const diffDays = Math.round((d - start) / 86400000);

    // Repeating on/off cycle (e.g. 8 weeks on, 4 off), indefinitely from the
    // protocol's start date — endDate above still acts as a hard outer stop
    // on top of this. Off days never reach the frequency check below.
    if (protocol.cycleOnWeeks && protocol.cycleOffWeeks) {
      const cycleDays = (protocol.cycleOnWeeks + protocol.cycleOffWeeks) * 7;
      if (diffDays % cycleDays >= protocol.cycleOnWeeks * 7) return false;
    }

    switch (protocol.frequency) {
      case 'daily':
        return true;
      case 'eod':
        return diffDays % 2 === 0;
      case 'weekly':
        return (protocol.daysOfWeek || []).includes(d.getDay());
      case 'asNeeded':
        return false;
      default:
        return false;
    }
  },

  // total mg/vial implied by a blend's fixed component recipe (e.g. KLOW's
  // GHK-Cu+KPV+BPC-157+TB-500 mgPerVial values summed) — this is what a
  // blend protocol's vialMgAssumed represents physically
  blendTotalMg(peptide) {
    return (peptide.components || []).reduce((sum, c) => sum + (c.mgPerVial || 0), 0);
  },

  // splits a blend's total dose (mg) proportionally across its components,
  // by the same ratio as their mgPerVial recipe — e.g. a 16mg KLOW dose
  // (1/5 of an 80mg vial) is 10mg GHK-Cu, 2mg each of KPV/BPC-157/TB-500
  blendComponentDoses(peptide, totalDoseMg) {
    const total = Calc.blendTotalMg(peptide);
    if (!total) return [];
    return (peptide.components || []).map(c => ({
      name: c.name,
      mg: totalDoseMg * (c.mgPerVial / total),
    }));
  },

  // amount of a single dose still "in system" `hoursSinceDose` later, given a
  // half-life — plain mono-exponential decay from the moment of the dose. This
  // is a relative indicator (mg-equivalent decayed by half-life alone), not a
  // true blood-concentration model — it ignores absorption phase, Vd, and
  // bioavailability, none of which this app has data for.
  decayAt(doseMg, hoursSinceDose, halfLifeHours) {
    if (hoursSinceDose < 0 || !halfLifeHours) return 0;
    return doseMg * Math.pow(0.5, hoursSinceDose / halfLifeHours);
  },

  // multi-dose superposition: sums decayAt() across every dose event at each
  // sample time. doseEvents is [{atHours, doseMg}], sampleHours is the list of
  // times (same hours-since-epoch axis as atHours) to plot.
  levelsOverTime(doseEvents, halfLifeHours, sampleHours) {
    return sampleHours.map(t => ({
      t,
      level: doseEvents.reduce((sum, ev) => sum + Calc.decayAt(ev.doseMg, t - ev.atHours, halfLifeHours), 0),
    }));
  },

  formatDate(date) {
    if (!date) return '—';
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  },

  round(n, places = 2) {
    const f = Math.pow(10, places);
    return Math.round(n * f) / f;
  },
};
