import json
UNITS = {
 'LIGHT_4X2': ('Light vehicle 4x2', [('STEER',False),('DRIVE',False)]),
 'RIGID_4X2': ('Rigid truck 4x2', [('STEER',False),('DRIVE',True)]),
 'RIGID_6X4': ('Rigid truck 6x4', [('STEER',False),('DRIVE',True),('DRIVE',True)]),
 'HORSE_4X2': ('Truck tractor 4x2', [('STEER',False),('DRIVE',True)]),
 'HORSE_6X4': ('Truck tractor 6x4', [('STEER',False),('DRIVE',True),('DRIVE',True)]),
 'TRAILER_2': ('2-axle trailer', [('TRAILER',True),('TRAILER',True)]),
 'TRAILER_3': ('3-axle trailer', [('TRAILER',True),('TRAILER',True),('TRAILER',True)]),
 'DRAWBAR_2': ('2-axle drawbar trailer', [('TRAILER',True),('TRAILER',True)]),
}
CONFIGS = [
 ('BAC_TRUCKS','Truck tractor 4x2 - horse only','CONFIRMED',[('HORSE_4X2','Horse')]),
 ('BAC_LINKS','Superlink / interlink','CONFIRMED',[('HORSE_6X4','Horse'),('TRAILER_2','6m link'),('TRAILER_2','12m link')]),
 ('HORSE_6X4','Truck tractor 6x4 - horse only','CONFIRMED',[('HORSE_6X4','Horse')]),
 ('TRAILER_2AXLE','2-axle trailer - standalone','CONFIRMED',[('TRAILER_2','Trailer')]),
 ('COMB_TRIAXLE','Tri-axle - horse plus 3-axle semi','PROPOSED',[('HORSE_6X4','Horse'),('TRAILER_3','Tri-axle trailer')]),
 ('TRAILER_3AXLE','Tri-axle trailer - standalone','PROPOSED',[('TRAILER_3','Tri-axle trailer')]),
 ('COMB_SIDETIP_IL','Side tipper - interlink','PROPOSED',[('HORSE_6X4','Horse'),('TRAILER_2','6m tipper'),('TRAILER_2','12m tipper')]),
 ('COMB_SIDETIP_TA','Side tipper - tri-axle','PROPOSED',[('HORSE_6X4','Horse'),('TRAILER_3','Tri-axle tipper')]),
 ('COMB_FUEL_IL','Fuel carrier - interlink tanker','PROPOSED',[('HORSE_6X4','Horse'),('TRAILER_2','6m tanker'),('TRAILER_2','12m tanker')]),
 ('COMB_FUEL_TA','Fuel carrier - tri-axle tanker','PROPOSED',[('HORSE_6X4','Horse'),('TRAILER_3','Tri-axle tanker')]),
 ('COMB_FUEL_RD','Fuel carrier - rigid plus drawbar','PROPOSED',[('RIGID_6X4','Rigid tanker'),('DRAWBAR_2','Drawbar tanker')]),
 ('COMB_SUPERLINK_23','Superlink 2+3 variant','VARIANT',[('HORSE_6X4','Horse'),('TRAILER_2','6m link'),('TRAILER_3','12m link')]),
 ('RIGID_4X2','Rigid truck 4x2','PROPOSED',[('RIGID_4X2','Rigid')]),
 ('LIGHT_4X2','Light vehicle 4x2','PROPOSED',[('LIGHT_4X2','Vehicle')]),
]
def build(units):
    rows=[]; comb=0; axle=0
    for ui,(ut,label) in enumerate(units):
        _,axles = UNITS[ut]; own=0
        for cls,dual in axles:
            axle+=1
            slots=[('LEFT','OUTER'),('LEFT','INNER'),('RIGHT','INNER'),('RIGHT','OUTER')] if dual else [('LEFT','SINGLE'),('RIGHT','SINGLE')]
            for side,slot in slots:
                comb+=1; own+=1
                rows.append(dict(comb=comb,own=own,unit=label,useq=ui+1,axle=axle,cls=cls,side=side,slot=slot))
    return rows

L=["-- Seed: axle configuration library (SRS v1.3 Appendix I) + R13 fixture",
   "-- Generated from the same model as the SRS appendix; do not hand-edit.",
   "SET search_path = app, public;",""]
L.append("-- Two tenants. Isolation must hold at n=2 (SRS Appendix H).")
L.append("INSERT INTO app.tenant (id,name,subdomain,state) VALUES")
L.append("  ('11111111-1111-1111-1111-111111111111','BAC Transport','bac','ACTIVE'),")
L.append("  ('22222222-2222-2222-2222-222222222222','Second Fleet (isolation control)','other','ACTIVE');")
L.append("")
for tid in ['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222']:
    L.append(f"SET LOCAL app.tenant_id = '{tid}';")
    L.append("-- policy thresholds (CR-005: never hard-coded). effective_from is a fixed")
    L.append("-- backdate, not load time: as-at valuation (FR-VAL-020/021) resolves the")
    L.append("-- policy effective at the requested date, so policy must predate every")
    L.append("-- seeded reading or historical dates would value as 'no policy configured'.")
    for k,v in [('removal_threshold_mm',4),('warning_threshold_mm',6),
                ('tread_reading_count',3),
                ('tread_reading_labels',["OUTER","CENTRE","INNER"]),
                ('pressure_deviation_margin_pct',25),
                ('spare_capture_scope','COMBINATION'),
                ('width_spread_warn_mm',4),('dual_mate_warn_mm',3),('axle_divergence_warn_mm',3),
                ('tread_bands',[[0,4],[5,7],[8,10],[11,13],[14,None]]),
                ('inflation_bands',{"dangerously_under":[0,80],"under":[80,90],"correct":[90,110],"over":[110,120],"dangerously_over":[120,None]}),
                ('target_pressure_kpa',{"STEER":800,"DRIVE":750,"TRAILER":750}),
                # FR-VAL-021 staleness indication; 60 days is the gap the survey
                # itself exposed (R2: a 2021-08-05 reading on a 2021-10-04 report)
                ('reading_staleness_days',60),
                # FR-ANL-002 minimum separation between the pair a wear rate
                # is computed over. Below it the readings are dominated by
                # gauge and operator variation rather than by wear.
                ('wear_rate_min_distance_km',1000)]:
        L.append(f"INSERT INTO app.configuration (tenant_id,key,value,effective_from) VALUES ('{tid}','{k}','{json.dumps(v)}'::jsonb,'2024-01-01T00:00:00Z');")
    L.append("")
    for code,name,status,units in CONFIGS:
        rows=build(units)
        ax=len(set(r['axle'] for r in rows))
        L.append(f"INSERT INTO app.axle_configuration (id,tenant_id,code,name,axle_count,evidential_status)")
        L.append(f"  VALUES (md5('{tid}{code}')::uuid,'{tid}','{code}',$${name}$$,{ax},'{status}');")
        multi = len(units)>1
        vals=[]
        for r in rows:
            pcode = str(r['comb']) if multi else str(r['own'])
            vals.append(f"('{tid}',md5('{tid}{code}')::uuid,'{pcode}',{r['comb']},{r['axle']},'{r['cls']}','{r['side']}','{r['slot']}',false,$${r['unit']}$$)")
        # one spare per configuration, captured per FR-CFG-026
        vals.append(f"('{tid}',md5('{tid}{code}')::uuid,'S',{len(rows)+1},NULL,'SPARE',NULL,NULL,true,$${units[-1][1]}$$)")
        L.append("INSERT INTO app.position (tenant_id,configuration_id,code,sequence,axle_number,axle_class,side,slot,is_spare,unit_label) VALUES")
        L.append(",\n".join("  "+v for v in vals)+";")
        if multi:
            m=[]
            for r in rows:
                m.append(f"('{tid}',md5('{tid}{code}')::uuid,'{r['comb']}',{r['useq']},'{r['own']}')")
            L.append("INSERT INTO app.combination_position_map (tenant_id,configuration_id,combination_code,member_sequence,member_position_code) VALUES")
            L.append(",\n".join("  "+v for v in m)+";")
        L.append("")
open('002_seed_configurations.sql','w').write("\n".join(L)+"\n")
print("seed written")
