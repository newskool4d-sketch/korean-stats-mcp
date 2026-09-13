// Explicit --import preload for release QA only. No production network calls.
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname !== 'kosis.kr') throw new Error('QA blocked unexpected outbound request');
  if (url.searchParams.get('tblId') === 'QA_FAILURE') {
    return new Response(JSON.stringify({ err: '20', errMsg: 'Controlled QA failure' }));
  }
  return new Response(JSON.stringify([
    { ORG_ID: '101', TBL_ID: 'QA', TBL_NM: 'QA fixture', PRD_DE: '2023', PRD_SE: 'Y', DT: '100', UNIT_NM: '명', ITM_NM: '인구', C1_NM: '전국' },
    { ORG_ID: '101', TBL_ID: 'QA', TBL_NM: 'QA fixture', PRD_DE: '2024', PRD_SE: 'Y', DT: '110', UNIT_NM: '명', ITM_NM: '인구', C1_NM: '전국' },
  ]), { headers: { 'content-type': 'application/json' } });
};
