      * ACCTMSTR.cpy - account master record (synthetic data only).
      * Fixed length 100 bytes, no record delimiter.
       01  ACCTMSTR-REC.
           05  ACCT-ID             PIC 9(10).
           05  ACCT-NAME           PIC X(25).
           05  ACCT-STATUS         PIC X.
           05  OPEN-DATE           PIC 9(6).
           05  BALANCE             PIC S9(9)V99.
           05  CREDIT-LIMIT        PIC S9(7)V99 COMP-3.
           05  RATE                PIC 9V999.
           05  TAX-ID              PIC X(9).
           05  MEMO                PIC X(25).
           05  FILLER              PIC X(4).
