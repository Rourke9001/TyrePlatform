import json

# CHG-070..073: the configuration library describes UNITS, not combinations
# (CFL-008, ADR-0007). A rig is a dated composition of units; its numbering is
# a display projection computed at render time (CFL-006), so no combination
# entry and no position map exist here. Body type is a vehicle attribute
# (CHG-071), so the tipper/tanker/tautliner entries collapsed into these six.
#
# Status per CHG-072: BAC confirmed it runs only what its own sheets show.
# UNVERIFIED is not "proposed" — nobody proposed anything (CFL-008).
UNITS = [
 # code            name                 kind      status        axles: (class, dual?)
 ('HORSE_4X2',    'Truck tractor 4x2', 'HORSE',  'CONFIRMED',  [('STEER',False),('DRIVE',True)]),
 ('HORSE_6X4',    'Truck tractor 6x4', 'HORSE',  'CONFIRMED',  [('STEER',False),('DRIVE',True),('DRIVE',True)]),
 ('TRAILER_2AXLE','2-axle trailer',    'TRAILER','CONFIRMED',  [('TRAILER',True),('TRAILER',True)]),
 ('TRAILER_3AXLE','3-axle trailer',    'TRAILER','UNVERIFIED', [('TRAILER',True),('TRAILER',True),('TRAILER',True)]),
 ('RIGID_4X2',    'Rigid truck 4x2',   'RIGID',  'UNVERIFIED', [('STEER',False),('DRIVE',True)]),
 ('LIGHT_4X2',    'Light vehicle 4x2', 'LIGHT',  'UNVERIFIED', [('STEER',False),('DRIVE',False)]),
]

def build(axles):
    rows=[]; own=0
    for axle,(cls,dual) in enumerate(axles, start=1):
        slots=[('LEFT','OUTER'),('LEFT','INNER'),('RIGHT','INNER'),('RIGHT','OUTER')] if dual else [('LEFT','SINGLE'),('RIGHT','SINGLE')]
        for side,slot in slots:
            own+=1
            rows.append(dict(own=own,axle=axle,cls=cls,side=side,slot=slot))
    return rows

L=["-- Seed: axle configuration library (unit types per CHG-070..073) + policy seeds",
   "-- Generated from the same model as the spec reference; do not hand-edit.",
   "SET search_path = app, public;",""]
L.append("-- Two tenants. Isolation must hold at n=2 (SRS Appendix H).")
L.append("INSERT INTO app.tenant (id,name,subdomain,state) VALUES")
L.append("  ('11111111-1111-1111-1111-111111111111','BAC Transport','bac','ACTIVE'),")
L.append("  ('22222222-2222-2222-2222-222222222222','Second Fleet (isolation control)','other','ACTIVE');")
L.append("")
for tid in ['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222']:
    L.append(f"SET LOCAL app.tenant_id = '{tid}';")
    L.append("-- policy values (CR-005: never hard-coded). effective_from is a fixed")
    L.append("-- backdate, not load time: as-at valuation (FR-VAL-020/021) resolves the")
    L.append("-- policy effective at the requested date, so policy must predate every")
    L.append("-- seeded reading or historical dates would value as 'no policy configured'.")
    for k,v in [('tread_reading_count',3),
                ('spare_capture_scope','COMBINATION'),
                ('width_spread_warn_mm',4),('dual_mate_warn_mm',3),('axle_divergence_warn_mm',3),
                ('tread_bands',[[0,4],[5,7],[8,10],[11,13],[14,None]]),
                # FR-VAL-021 staleness indication; 60 days is the gap the survey
                # itself exposed (R2: a 2021-08-05 reading on a 2021-10-04 report)
                ('reading_staleness_days',60),
                # FR-ANL-002 minimum separation between the pair a wear rate
                # is computed over. Below it the readings are dominated by
                # gauge and operator variation rather than by wear.
                ('wear_rate_min_distance_km',1000)]:
        L.append(f"INSERT INTO app.configuration (tenant_id,key,value,effective_from) VALUES ('{tid}','{k}','{json.dumps(v)}'::jsonb,'2024-01-01T00:00:00Z');")
    L.append("")
    L.append("-- CHG-111: threshold_policy is the one threshold source; the old")
    L.append("-- removal_threshold_mm / warning_threshold_mm config keys are retired.")
    L.append("-- Both retread and scrap sit at 4.0mm: BAC runs a single pull point")
    L.append("-- today, and 4mm is its policy figure — never a legal claim (CFL-012).")
    L.append("INSERT INTO app.threshold_policy (id,tenant_id,retread_threshold_mm,scrap_threshold_mm,warning_threshold_mm,effective_from)")
    L.append(f"  VALUES (md5('{tid}thrpol-default')::uuid,'{tid}',4.0,4.0,6.0,'2024-01-01T00:00:00Z');")
    L.append("-- CHG-038: retreads are not fitted to steer axles — fleet practice, not a")
    L.append("-- legal claim (CHG-107 tracks the sign-off question). A seeded row, so the")
    L.append("-- rule is data the resolver can reach, not a comment.")
    L.append("INSERT INTO app.threshold_policy (id,tenant_id,axle_class,retread_threshold_mm,scrap_threshold_mm,warning_threshold_mm,retreads_permitted,effective_from)")
    L.append(f"  VALUES (md5('{tid}thrpol-steer')::uuid,'{tid}','STEER',4.0,4.0,6.0,false,'2024-01-01T00:00:00Z');")
    L.append("")
    L.append("-- CHG-112/CHG-034: target_pressure is the one pressure-target source; the")
    L.append("-- target_pressure_kpa / inflation_bands / pressure_deviation_margin_pct")
    L.append("-- config keys are retired. The band edges the old keys drew at 80/90/110/120%")
    L.append("-- survive as the warn/critical tolerances (10/20% each side). No SPARE row on")
    L.append("-- purpose: a spare's pressure is unclassifiable, never silently compliant.")
    for cls,kpa in [('STEER',800),('DRIVE',750),('TRAILER',750)]:
        L.append("INSERT INTO app.target_pressure (id,tenant_id,axle_class,target_kpa,warn_under_pct,critical_under_pct,warn_over_pct,critical_over_pct,effective_from)")
        L.append(f"  VALUES (md5('{tid}tgtp-{cls}')::uuid,'{tid}','{cls}',{kpa},10.0,20.0,10.0,20.0,'2024-01-01T00:00:00Z');")
    L.append("")
    for code,name,kind,status,axles in UNITS:
        rows=build(axles)
        L.append(f"INSERT INTO app.axle_configuration (id,tenant_id,code,name,axle_count,evidential_status,default_spare_count)")
        L.append(f"  VALUES (md5('{tid}{code}')::uuid,'{tid}','{code}',$${name}$$,{len(axles)},'{status}',1);")
        vals=[]
        for r in rows:
            vals.append(f"('{tid}',md5('{tid}{code}')::uuid,'{r['own']}',{r['own']},{r['axle']},'{r['cls']}','{r['side']}','{r['slot']}',false,'FIXED',NULL,$${name}$$)")
        # CHG-031: the spare position is a default; the real count is whatever
        # inspections find, so more spare positions may exist per unit in data
        vals.append(f"('{tid}',md5('{tid}{code}')::uuid,'S',{len(rows)+1},NULL,'SPARE',NULL,NULL,true,'FIXED',1,$${name}$$)")
        L.append("INSERT INTO app.position (tenant_id,configuration_id,code,sequence,axle_number,axle_class,side,slot,is_spare,axle_type,spare_ordinal,unit_label) VALUES")
        L.append(",\n".join("  "+v for v in vals)+";")
        L.append("")
open('002_seed_configurations.sql','w').write("\n".join(L)+"\n")
print("seed written")
