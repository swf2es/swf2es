// Included before each of jxrlib's files: segdec.c calls strcodec.c's
// _byteswap_ulong, which no header of jxrlib's declares off Windows.
unsigned int _byteswap_ulong(unsigned int bits);
