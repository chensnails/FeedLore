/* 轻量中文拼音表（全拼，无声调），用于命令面板按拼音过滤。
 * 仅覆盖常用字，未知汉字静默跳过（直接输入汉字仍可匹配），不影响其它搜索。
 * 从旧 public/app.js 原样移植，行为保持一致。 */

export const PINYIN = {
  切:'qie',换:'huan',到:'dao',文:'wen',章:'zhang',页:'ye',卡:'ka',片:'pian',主:'zhu',题:'ti',
  外:'wai',观:'guan',数:'shu',据:'ju',源:'yuan',模:'mo',型:'xing',账:'zhang',号:'hao',状:'zhuang',
  态:'tai',设:'she',置:'zhi',阅:'yue',读:'du',范:'fan',围:'wei',全:'quan',部:'bu',未:'wei',
  收:'shou',藏:'cang',重:'chong',新:'xin',拉:'la',取:'qu',聚:'ju',焦:'jiao',索:'suo',回:'hui',
  顶:'ding',转:'zhuan',已:'yi',打:'da',开:'kai',暗:'an',色:'se',浅:'qian',亮:'liang',深:'shen',
  自:'zi',动:'dong',网:'wang',盘:'pan',云:'yun',链:'lian',接:'jie',件:'jian',资:'zi',讯:'xun',
  博:'bo',客:'ke',公:'gong',众:'zhong',微:'wei',信:'xin',科:'ke',技:'ji',财:'cai',经:'jing',
  股:'gu',票:'piao',基:'ji',金:'jin',影:'ying',视:'shi',音:'yin',乐:'yue',游:'you',戏:'xi',
  体:'ti',育:'yu',报:'bao',社:'she',区:'qu',团:'tuan',队:'dui',软:'ruan',计:'ji',美:'mei',
  食:'shi',旅:'lv',健:'jian',康:'kang',医:'yi',教:'jiao',育:'yu',书:'shu',店:'dian',购:'gou',
  物:'wu',房:'fang',车:'che',法:'fa',律:'lv',政:'zheng',治:'zhi',军:'jun',事:'shi',闻:'wen',
  中:'zhong',华:'hua',周:'zhou',刊:'kan',杂:'za',志:'zhi',界:'jie',首:'shou',次:'ci',最:'zui',
  精:'jing',选:'xuan',推:'tui',荐:'jian',创:'chuang',业:'ye',投:'tou',产:'chan',保:'bao',险:'xian',
  银:'yin',行:'hang',汽:'qi',码:'ma',手:'shou',机:'ji',电:'dian',脑:'nao',户:'hu',国:'guo',
  际:'ji',城:'cheng',市:'shi',乡:'xiang',村:'cun',山:'shan',河:'he',海:'hai',湖:'hu',花:'hua',
  鸟:'niao',鱼:'yu',猫:'mao',狗:'gou',宠:'chong',小:'xiao',说:'shuo',漫:'man',画:'hua',摄:'she',
  时:'shi',尚:'shang',潮:'chao',流:'liu',工:'gong',作:'zuo',职:'zhi',场:'chang',
  导:'dao',出:'chu',看:'kan',搜:'sou',查:'cha',找:'zhao',更:'geng',多:'duo',少:'shao',
  快:'kuai',帮:'bang',助:'zhu',关:'guan',用:'yong',登:'deng',录:'lu',退:'tui'
};

export function cjkPinyin(text) {
  const s = String(text || '');
  let full = '', initial = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 0x4e00 || code > 0x9fff) continue; // 跳过非汉字（英文/数字已在 keywords 中）
    const py = PINYIN[ch];
    if (!py) continue; // 未知汉字静默跳过，降级为「直接输汉字」仍可匹配
    full += py;
    initial += py[0];
  }
  return (full + ' ' + initial).trim();
}
