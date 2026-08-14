// 终端二维码输出：手机扫码直达
import qrcode from 'qrcode-terminal'

export function printQr(url, log) {
  log('手机扫码直达：')
  qrcode.generate(url, { small: true }, (qr) => log('\n' + qr))
}
