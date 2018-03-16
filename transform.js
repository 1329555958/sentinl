var HostMap = {
    dian_wo_da_app1:'点我达生产',
    dian_wo_da_app2:'点我达生产',
    dian_wo_da_app3:'点我达生产',
    dian_wo_da_app4:'点我达生产',
    app5:'2.1生产',
    app6:'2.1生产',
    app7:'2.1生产',
    app8:'2.1生产'

};
var now = new Date();
payload.start = now.toLocaleTimeString();
var map = {}, hits = payload.hits.hits;
for (var i = 0; i < hits.length; i++) {
    var source = hits[i]._source;
    if (!map[source.partner_id]) {
        map[source.partner_id] = {};
    }
    var partner = map[source.partner_id];
    if (!partner[source.interface_type]) {
        partner[source.interface_type] = [];
    }
    var infs = partner[source.interface_type];
    infs.push(source);
}
var result = [], partner_index = 0, request_index = 0;
for (var id in map) {
    var partner = map[id];
    var infs = [];
    result.push({index: ++partner_index, id: id, name: '商户号', infs: infs});
    var inf_index = 0;
    for (var name in partner) {
        var requests = [];
        infs.push({index: ++inf_index, id: name, name: '接口名', requests: requests});
        var inf = partner[name];
        for (var i = 0; i < inf.length; i++) {
            inf[i].index = ++request_index;
            var utcime = new Date( inf[i].request_time);
            var localTime = new Date(utcime.getTime() + 8 * 60 * 60 * 1000);
            inf[i].request_time = localTime.toJSON();
            inf[i].hostName = HostMap[inf[i].host] ||  inf[i].host;
            requests.push(inf[i]);
        }
    }
}
payload.result = result;
