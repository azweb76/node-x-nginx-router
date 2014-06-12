function render(template, obj){
	var s = '', idx = 0, endIdx = 0, lastIdx = 0, key = '';
	while(true){
		idx = template.indexOf('${', lastIdx);
		if (idx > -1){
			endIdx = template.indexOf('}', idx);
			if (endIdx > -1){
				s += template.substr(lastIdx, idx-lastIdx);
				key = template.substr(idx+2, endIdx-idx-2);
				s += obj[key].toString();
				lastIdx = endIdx+1;
			}
			else {
				break;
			}
		}
		else {
			break;
		}
	}
	s += template.substr(lastIdx);
	return s;
}

module.exports = {
	render: render
};