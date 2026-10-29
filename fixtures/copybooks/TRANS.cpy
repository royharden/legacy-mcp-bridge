      * TRANS.cpy - account transaction record (synthetic data only).
      * Fixed length 80 bytes, no record delimiter.
       01  TRANS-REC.
           05  TRAN-ID             PIC 9(10).
           05  ACCT-ID             PIC 9(10).
           05  TRAN-DATE           PIC 9(6).
           05  TRAN-TYPE           PIC X.
           05  AMOUNT              PIC S9(7)V99.
           05  TRAN-STATUS         PIC X.
           05  DESC                PIC X(30).
           05  FILLER              PIC X(13).
