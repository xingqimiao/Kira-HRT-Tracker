import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = process.env.HRT_MCP_TOKEN;
if (!token) throw new Error('HRT_MCP_TOKEN is required');

const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8788/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'local-account-check', version: '1.0.0' });
await client.connect(transport);

const parse = (result) => {
    if (result.isError) throw new Error(result.content?.[0]?.text ?? 'MCP call failed');
    return JSON.parse(result.content[0].text);
};

const { tools } = await client.listTools();
const reference = parse(await client.callTool({ name: 'hrt_reference', arguments: {} }));
const esterGroups = Object.values(reference.esters ?? {});
const esterValues = new Set(esterGroups.flatMap(group => Object.keys(group ?? {})));
const foundEsters = ['P4', 'MPA', 'NET', 'RALOX', 'FIN', 'DUT', 'GNRH'].filter(e => esterValues.has(e));

const at = new Date();
const iso = at.toISOString();
const p4 = parse(await client.callTool({
    name: 'hrt_add_medication',
    arguments: { route: 'oral', ester: 'P4', dose_mg: 100, at: iso, extras: {} },
}));
const gel = parse(await client.callTool({
    name: 'hrt_add_medication',
    arguments: {
        route: 'gel', ester: 'E2', dose_mg: 1.5, at: iso,
        extras: { gelSite: 1, gelProductId: 4, gelCoverage: 2, gelCoApplied: 1, gelWashAfterH: 6 },
    },
}));
const sub = parse(await client.callTool({
    name: 'hrt_add_medication',
    arguments: { route: 'sublingual', ester: 'EV', dose_mg: 2, at: iso, extras: { sublingualTier: 2 } },
}));
const patch = parse(await client.callTool({
    name: 'hrt_add_medication',
    arguments: {
        route: 'patchApply', ester: 'E2', dose_mg: 0.001, at: iso,
        extras: { releaseRateUGPerDay: 100, patchWearH: 84, vehicle: 1 },
    },
}));
const template = parse(await client.callTool({
    name: 'hrt_add_dose_template',
    arguments: { name: 'MCP P4 template', route: 'oral', ester: 'P4', dose_mg: 100 },
}));

const meds = parse(await client.callTool({ name: 'hrt_list_medications', arguments: { limit: 50 } }));
const settings = parse(await client.callTool({ name: 'hrt_get_settings', arguments: {} }));
const timeline = parse(await client.callTool({ name: 'hrt_get_timeline', arguments: { limit: 20 } }));
const templates = parse(await client.callTool({ name: 'hrt_list_dose_templates', arguments: {} }));

const byId = (id) => meds.find(m => m.record_id === id) ?? meds.find(m => m.id === id);
console.log(JSON.stringify({
    toolCount: tools.length,
    hasAddMedication: tools.some(t => t.name === 'hrt_add_medication'),
    hasAddTemplate: tools.some(t => t.name === 'hrt_add_dose_template'),
    referenceEsters: foundEsters,
    referenceRoutes: reference.routes,
    writes: {
        p4: !!p4.record_id,
        gel: !!gel.record_id,
        sublingual: !!sub.record_id,
        patch: !!patch.record_id,
        template: !!template.record_id,
    },
    readBack: {
        p4: byId(p4.record_id),
        gelExtras: byId(gel.record_id)?.extras,
        sublingualExtras: byId(sub.record_id)?.extras,
        patchExtras: byId(patch.record_id)?.extras,
        template: templates.find(t => t.record_id === template.record_id || t.id === template.record_id),
        pkParams: settings.pkParams,
        timelineCount: timeline.length,
    },
}, null, 2));

await client.close();
