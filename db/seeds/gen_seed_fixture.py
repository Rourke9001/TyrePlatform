R = {
 1:(800,[13,13,14]),  2:(800,[15,14,14]),
 3:(750,[14,12,15]),  4:(750,[14,12,14]),  5:(750,[15,11,15]),  6:(700,[17,11,16]),
 7:(750,[6,1,6]),     8:(750,[5,1,6]),     9:(750,[9,6,8]),    10:(750,[7,7,8]),
11:(750,[6,4,4]),    12:(750,[6,5,4]),    13:(700,[6,6,4]),    14:(750,[5,6,5]),
15:(750,[7,7,6]),    16:(200,[7,4,5]),    17:(750,[8,7,8]),    18:(750,[0,5,8]),
19:(700,[9,8,8]),    20:(750,[8,7,8]),    21:(750,[3,3,3]),    22:(750,[4,3,4]),
23:(750,[12,12,12]), 24:(700,[11,10,10]), 25:(750,[14,13,14]), 26:(750,[14,14,14]),
}
SPARE=(700,[6,2,6])
T="11111111-1111-1111-1111-111111111111"
LABELS=['OUTER','CENTRE','INNER']
# combination position -> (member sequence, own code)
def member(p):
    if p<=10: return (1,str(p))
    if p<=18: return (2,str(p-10))
    return (3,str(p-18))
UNIT={1:('HORSE','BAC039SP','HORSE_6X4','Horse'),2:('LINK6','BAC040SP','TRAILER_2AXLE','6m link'),3:('LINK12','BAC041SP','TRAILER_2AXLE','12m link')}

L=["-- Seed: R13 acceptance fixture (SRS v1.3 Appendix J)",
   "-- ONE completed capture sheet, used as a golden test case. Test data, not a",
   "-- condition assessment of any vehicle.",
   "SET search_path = app, public;",
   f"SET app.tenant_id = '{T}';",
   "BEGIN;",""]
L.append("INSERT INTO app.depot (id,tenant_id,name,type) VALUES (md5('depot1')::uuid,'%s','Johannesburg','DEPOT');"%T)
L.append("INSERT INTO app.app_user (id,tenant_id,email,display_name,staff_number,role) VALUES")
L.append("  (md5('driver1')::uuid,'%s','melusi@example.invalid','Melusi','EMP-0001','DRIVER');"%T)
L.append("INSERT INTO app.tyre_size (id,tenant_id,name,construction) VALUES (md5('sz1')::uuid,'%s','315/80R22.5','RADIAL');"%T)
L.append("INSERT INTO app.tyre_brand (id,tenant_id,name) VALUES (md5('br1')::uuid,'%s','Dunlop');"%T)
L.append("INSERT INTO app.tyre_pattern (id,tenant_id,name,brand_id) VALUES (md5('pt1')::uuid,'%s','SP431',md5('br1')::uuid);"%T)
L.append("")
# three vehicles
for seq,(fleet,reg,cfg,label) in UNIT.items():
    L.append(f"INSERT INTO app.vehicle (id,tenant_id,fleet_number,registration,configuration_id,body_type,unit_descriptor,home_depot_id,current_odometer,status)")
    L.append(f"  VALUES (md5('veh{seq}')::uuid,'{T}','{fleet}','{reg}',md5('{T}{cfg}')::uuid,'Flat deck',$${label}$$,md5('depot1')::uuid,412500,'ACTIVE');")
L.append("")
L.append(f"INSERT INTO app.combination (id,tenant_id,motive_vehicle_id,configuration_id) VALUES (md5('comb1')::uuid,'{T}',md5('veh1')::uuid,md5('{T}BAC_LINKS')::uuid);")
for seq,(fleet,reg,cfg,label) in UNIT.items():
    L.append(f"INSERT INTO app.combination_member (tenant_id,combination_id,vehicle_id,sequence,descriptor) VALUES ('{T}',md5('comb1')::uuid,md5('veh{seq}')::uuid,{seq},$${label}$$);")
L.append("")
L.append("-- Tyres. rand_per_mm follows BR-VAL-002 from an R4,320.00 purchase over 25mm")
L.append("-- new tread and a 4mm removal threshold => R205.71/mm, matching SRS Appendix E.")
allpos=[(p,member(p)) for p in sorted(R)]+[('S',(3,'S'))]
for p,(mseq,own) in allpos:
    tid=f"tyre{p}"
    L.append(f"INSERT INTO app.tyre (id,tenant_id,branded_number,size_id,brand_id,pattern_id,status,purchase_date,purchase_price,new_tread_mm,rand_per_mm,casing_value,state)")
    L.append(f"  VALUES (md5('{tid}')::uuid,'{T}','2102BAC{p}',md5('sz1')::uuid,md5('br1')::uuid,md5('pt1')::uuid,'NEW','2024-03-01',4320.00,25.0,205.7100,1837.50,'FITTED');")
L.append("")
L.append("-- Fitments: each tyre on its own unit's own position code (BR-VEH-003).")
for p,(mseq,own) in allpos:
    L.append(f"INSERT INTO app.fitment (tenant_id,tyre_id,vehicle_id,position_id,fitted_at,fitted_odometer,fitted_tread_mm)")
    L.append(f"  SELECT '{T}',md5('tyre{p}')::uuid,md5('veh{mseq}')::uuid,pos.id,'2025-06-01T06:00:00Z',380000,25.0")
    L.append(f"    FROM app.position pos JOIN app.vehicle v ON v.configuration_id=pos.configuration_id")
    L.append(f"   WHERE v.id=md5('veh{mseq}')::uuid AND pos.code='{own}';")
L.append("")
L.append("INSERT INTO app.inspection (id,tenant_id,vehicle_id,combination_id,user_id,client_uuid,started_at,submitted_at,odometer,device_id,app_version,duration_seconds,comment,defect_report)")
L.append(f"  VALUES (md5('insp1')::uuid,'{T}',md5('veh1')::uuid,md5('comb1')::uuid,md5('driver1')::uuid,md5('cli1')::uuid,")
L.append("          '2026-07-23T05:40:00Z','2026-07-23T05:46:30Z',412500,'seed-fixture','0.0.0-fixture',390,")
L.append("          $$7/8 are needed to be replaced. 21/22 are almost finished. 18 need its smooth one side. Trailers need to be checked, bushies and alignment.$$,")
L.append("          $$Trailers are leaking water when raining.$$);")
L.append("")
for p,(mseq,own) in allpos:
    kpa,rd = (SPARE if p=='S' else R[p])
    L.append(f"INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)")
    L.append(f"  SELECT md5('rd{p}')::uuid,'{T}',md5('insp1')::uuid,md5('veh{mseq}')::uuid,pos.id,md5('tyre{p}')::uuid,{kpa}")
    L.append(f"    FROM app.position pos JOIN app.vehicle v ON v.configuration_id=pos.configuration_id")
    L.append(f"   WHERE v.id=md5('veh{mseq}')::uuid AND pos.code='{own}';")
    vals=",".join(f"('{T}',md5('rd{p}')::uuid,{i+1},'{LABELS[i]}',{v})" for i,v in enumerate(rd))
    L.append(f"INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,label,tread_mm) VALUES {vals};")
L.append("")
L.append("COMMIT;")
open('/home/claude/db/003_seed_fixture.sql','w').write("\n".join(L)+"\n")
print("fixture written")
